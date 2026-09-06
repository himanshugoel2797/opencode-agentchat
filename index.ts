// opencode-agentchat — chat rooms for agents and subagents working together.
//
// Every agent session (primary or subagent) gets a unique name, can create
// and list chat rooms (each with a stated purpose), invite other agents,
// join rooms, exchange messages, and see a live directory of what every
// agent is doing. chat_spawn starts persistent worker sessions in new zellij
// tabs so long-running agents outlive the session that spawned them.
//
// Session liveness is LEASE-BASED: every session stamps its lastSeen as it
// works (tool execution, bus events, prompts) and persistent sessions
// heart-beat, so an idle-but-open terminal stays "alive" while finished
// subagents age out to "exited" after ~2 minutes of silence.
//
// State lives in <project>/.agentchat/ so it is shared by all sessions on
// the project and survives restarts. See docs/MAINTENANCE.md for the state
// schema and the opencode integration surface that must be re-checked on
// every opencode upgrade.

import * as fs from "node:fs"
import * as path from "node:path"
import { execFile } from "node:child_process"
import type { Plugin, ToolContext } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

const z = tool.schema

type AgentRecord = {
  sessionID: string
  name: string
  agent: string
  status: string
  statusAt: number
  registeredAt: number
  /** last confirmed activity/heartbeat; feeds the liveness lease (see I5) */
  lastSeen?: number
  /** roomId -> absolute message count already seen (see docs/MAINTENANCE.md) */
  reads: Record<string, number>
}

type Message = {
  /** absolute index across the room's full sequence, survives trimming */
  i: number
  ts: number
  from: string
  text: string
}

type Room = {
  id: string
  name: string
  purpose: string
  createdBy: string
  createdAt: number
  /** absolute index of messages[0]; everything below it was trimmed away */
  first: number
  members: string[]
  invites: string[]
  messages: Message[]
}

const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/
const MAX_MESSAGES = 1000
const MAX_ACTIVITY = 200
const STALE_MS = 120_000 // quiet this long -> lease expires, listed as exited
const HEARTBEAT_MS = 30_000 // persistent sessions re-stamp themselves
const SEEN_MAX = 400

export default (async ({ client, worktree, $ }: { client: any; worktree: string; $?: any }) => {
  const root = path.join(worktree, ".agentchat")
  const roomsDir = path.join(root, "rooms")
  const shellHandle = $ ?? undefined

  // In-memory activity log, fed by tool.execute.before. Keyed by sessionID.
  const activity = new Map<string, { tool: string; ts: number }>()

 // Sessions confirmed gone; dead sessions stay dead, so this is cacheable.
  const deadCache = new Set<string>()

  // Lease bookkeeping. `seen` = every session this process observed doing
  // work (tools / events / prompts); persistent sessions additionally
  // self-heartbeat. `parentKind` lets us tell subagents (parentID set) apart
  // from primary sessions — only primaries may become the heartbeat target.
  const seen = new Map<string, number>()
  const parentKind = new Map<string, "primary" | "sub" | "unknown">()
  let self: string | undefined
  const staleMs = Number.parseInt(process.env.AGENTCHAT_STALE_MS || "", 10) || STALE_MS

  // Bushook events carry the session id in different places depending on type
  // (session.* -> properties.info.id; message.* / part.* -> info/part.sessionID).
  const eventSessionID = (event: { type?: string; properties?: any }): string | undefined => {
    const p = event.properties
    if (!p) return undefined
    if (typeof p.sessionID === "string") return p.sessionID
    if (p.info?.sessionID) return p.info.sessionID
    if (p.part?.sessionID) return p.part.sessionID
    if (p.info?.id) return p.info.id
    return undefined
  }

  const readJSON = <T,>(file: string, fallback: T): T => {
    let raw: string
    try {
      raw = fs.readFileSync(file, "utf8")
    } catch {
      return fallback
    }
    try {
      return JSON.parse(raw) as T
    } catch {
      try {
        fs.renameSync(file, `${file}.corrupt-${Date.now()}`)
      } catch {}
      return fallback
    }
  }

  const writeJSON = (file: string, data: unknown) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
    fs.renameSync(tmp, file)
  }

  const agentsFile = () => path.join(root, "agents.json")

  const loadAgents = (): Record<string, AgentRecord> => readJSON(agentsFile(), {})

  // Merge-by-sessionID so concurrent writers (multiple opencode processes
  // on one worktree) cannot clobber each other's records.
  const saveRecord = (rec: AgentRecord): AgentRecord => {
    const agents = loadAgents()
    agents[rec.sessionID] = rec
    writeJSON(agentsFile(), agents)
    return rec
  }

  // A session's lease lives in the in-memory `seen` map (cheap on the busy
  // event stream) and is flushed to AgentRecord.lastSeen so OTHER processes
  // on the same worktree agree on its liveness.
  const saveSeen = (sessionID: string, ts: number) => {
    const agents = loadAgents()
    const rec = agents[sessionID]
    if (rec && (rec.lastSeen ?? 0) < ts) {
      rec.lastSeen = ts
      writeJSON(agentsFile(), agents)
    }
  }

  const flushSeen = () => {
    const agents = loadAgents()
    let dirty = false
    for (const [id, ts] of seen) {
      const rec = agents[id]
      if (rec && (rec.lastSeen ?? 0) < ts) {
        rec.lastSeen = ts
        dirty = true
      }
    }
    if (dirty) writeJSON(agentsFile(), agents)
  }

  const markSeen = (sessionID: string) => {
    seen.set(sessionID, Date.now())
    if (seen.size > SEEN_MAX) {
      flushSeen()
      while (seen.size > SEEN_MAX) {
        const oldest = seen.keys().next().value
        if (oldest === undefined) break
        seen.delete(oldest)
      }
    }
  }

  const takenNames = (agents: Record<string, AgentRecord>): Set<string> =>
    new Set(Object.values(agents).map((a) => a.name))

  const sanitize = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 24) || "agent"

  // Lazily register the calling session under a unique default name. A
  // session spawned via chat_spawn claims AGENTCHAT_NAME (deterministic) and
  // auto-joins AGENTCHAT_ROOM; both env vars are read fresh each call so only
  // the spawned process is affected.
  const ensureAgent = (ctx: ToolContext): AgentRecord => {
    markSeen(ctx.sessionID)
    const agents = loadAgents()
    const existing = agents[ctx.sessionID]
    if (existing) {
      if (!existing.lastSeen) {
        existing.lastSeen = Date.now()
        writeJSON(agentsFile(), agents)
      }
      maybeAutoJoin(existing)
      return existing
    }
    const taken = takenNames(agents)
    const envName = (process.env.AGENTCHAT_NAME || "").trim()
    const wanted =
      envName &&
      NAME_RE.test(envName) &&
      !Object.values(agents).some((a) => a.name === envName && a.sessionID !== ctx.sessionID)
        ? envName
        : undefined
    const base = wanted ?? `${sanitize(ctx.agent)}-${ctx.sessionID.slice(-4)}`
    let name = base
    let n = 2
    while (taken.has(name)) name = `${base}-${n++}`
    const rec = saveRecord({
      sessionID: ctx.sessionID,
      name,
      agent: ctx.agent,
      status: "",
      statusAt: 0,
      registeredAt: Date.now(),
      lastSeen: Date.now(),
      reads: {},
    })
    maybeAutoJoin(rec)
    return rec
  }

  const sessionAlive = async (sessionID: string): Promise<boolean> => {
    if (deadCache.has(sessionID)) return false
    const rec = loadAgents()[sessionID]
    const lastSeen = Math.max(seen.get(sessionID) ?? 0, rec?.lastSeen ?? 0)
    if (lastSeen > 0 && Date.now() - lastSeen >= staleMs) return false // lease expired
    try {
      const res = await client.session.get({ path: { id: sessionID } })
      if (res?.error || !res?.data) {
        deadCache.add(sessionID)
        return false
      }
    } catch {
      // server unreachable — fail open
    }
    return true
  }

  // The session of THIS opencode process (a primary, non-subagent session)
  // gets heart-beat so an idle-but-open terminal stays alive. Subagents
  // (parentID set) are never self; probe failures are never self.
  const classifySelf = async (sessionID: string) => {
    if (self) return
    const known = parentKind.get(sessionID)
    if (known) {
      if (known === "primary") self = sessionID
      return
    }
    let kind: "primary" | "sub" | "unknown" = "unknown"
    try {
      const res = await client.session.get({ path: { id: sessionID } })
      if (res?.error || !res?.data) {
        deadCache.add(sessionID)
        kind = "unknown"
      } else {
        kind = res.data.parentID ? "sub" : "primary"
      }
    } catch {
      kind = "unknown"
    }
    parentKind.set(sessionID, kind)
    if (parentKind.size > MAX_ACTIVITY) {
      const oldest = parentKind.keys().next().value
      if (oldest !== undefined && oldest !== sessionID) parentKind.delete(oldest)
    }
    if (kind === "primary") self = sessionID
  }

  const heartbeat = () => {
    const now = Date.now()
    if (self && !deadCache.has(self)) {
      seen.set(self, now)
      saveSeen(self, now)
    }
    flushSeen()
  }

  const heartbeatTimer = setInterval(heartbeat, HEARTBEAT_MS)
  if (typeof (heartbeatTimer as any)?.unref === "function") (heartbeatTimer as any).unref()

  // Room identity is the FILENAME; embedded ids in hand-edited files are
  // never trusted (a crafted id like "../../x" must not reach roomFile()).
  const ROOM_ID_RE = /^[a-z0-9-]+$/

  const roomFile = (id: string) => {
    if (!ROOM_ID_RE.test(id)) throw new Error(`invalid room id: ${JSON.stringify(id)}`)
    return path.join(roomsDir, `${id}.json`)
  }

  // expectedId = the filename this room was loaded from; a mismatch means the
  // file was hand-edited and is skipped (never written back under its id).
  const normalizeRoom = (r: Room | undefined, expectedId: string): Room | undefined => {
    if (!r || !r.id || r.id !== expectedId || !ROOM_ID_RE.test(expectedId)) return undefined
    r.first = typeof r.first === "number" ? r.first : 0
    r.members ??= []
    r.invites ??= []
    r.messages ??= []
    return r
  }

  const loadRoom = (id: string): Room | undefined => normalizeRoom(loadRoomRaw(id), id)
  function loadRoomRaw(id: string): Room | undefined {
    try {
      return readJSON<Room>(roomFile(id), undefined as unknown as Room)
    } catch {
      return undefined
    }
  }

  const trimRoom = (room: Room) => {
    if (room.messages.length > MAX_MESSAGES) {
      const cut = room.messages.length - MAX_MESSAGES
      room.messages.splice(0, cut)
      room.first += cut
    }
  }

  const pushMessage = (room: Room, from: string, text: string): Message => {
    const m: Message = {
      i: room.first + room.messages.length,
      ts: Date.now(),
      from,
      text: text.trim().slice(0, 4000),
    }
    room.messages.push(m)
    trimRoom(room)
    return m
  }

  // Reload from disk before mutating so concurrent processes don't lose
  // messages or membership changes.
  const mutateRoom = (id: string, fn: (room: Room) => void): Room | undefined => {
    const fresh = loadRoom(id)
    if (!fresh) return undefined
    fn(fresh)
    trimRoom(fresh)
    writeJSON(roomFile(id), fresh)
    return fresh
  }

  // Remove a dead holder's registration: delete its record and purge the name
  // from every room's members/invites. Caller must have confirmed it isn't alive.
  const purgeRecord = (holderSessionID: string) => {
    const agents = loadAgents()
    const rec = agents[holderSessionID]
    if (!rec) return
    delete agents[holderSessionID]
    writeJSON(agentsFile(), agents)
    for (const room of allRooms()) {
      let dirty = false
      if (room.members.includes(rec.name)) {
        room.members = room.members.filter((n) => n !== rec.name)
        dirty = true
      }
      if (room.invites.includes(rec.name)) {
        room.invites = room.invites.filter((n) => n !== rec.name)
        dirty = true
      }
      if (dirty) writeJSON(roomFile(room.id), room)
    }
  }

  const allRooms = (): Room[] => {
    try {
      return fs
        .readdirSync(roomsDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => normalizeRoom(readJSON<Room>(path.join(roomsDir, f), undefined as unknown as Room), f.slice(0, -".json".length)))
        .filter((r): r is Room => !!r)
    } catch {
      return []
    }
  }

  const slug = (name: string) =>
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "room"

  const resolveRoom = (ref: string): Room | undefined => {
    const rooms = allRooms()
    return (
      rooms.find((r) => r.id === ref) ||
      rooms.find((r) => r.name === ref) ||
      rooms.find((r) => r.name.toLowerCase() === ref.toLowerCase())
    )
  }

  const roomListError = (ref: string) => {
    const rooms = allRooms()
    return rooms.length
      ? `No room "${ref}" found. Available: ${rooms.map((r) => `${r.id} ("${r.name}")`).join(", ")}`
      : `No room "${ref}" found and no rooms exist yet. Create one with chat_room_create.`
  }

  // chat_spawn-child support: auto-join a room given via AGENTCHAT_ROOM (in
  // the spawned process's env). Ordinary sessions never set it, so this is a
  // no-op unless the process was spawned as a persistent worker.
  const maybeAutoJoin = (rec: AgentRecord) => {
    const ref = (process.env.AGENTCHAT_ROOM || "").trim()
    if (!ref) return
    const room = resolveRoom(ref)
    if (room && !room.members.includes(rec.name)) {
      mutateRoom(room.id, (r) => {
        if (!r.members.includes(rec.name)) r.members.push(rec.name)
      })
    }
  }

  const ago = (ts: number): string => {
    if (!ts) return "never"
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
    if (s < 60) return `${s}s ago`
    if (s < 3600) return `${Math.round(s / 60)}m ago`
    if (s < 86400) return `${Math.round(s / 3600)}h ago`
    return `${Math.round(s / 86400)}d ago`
  }

  const clock = (ts: number) => new Date(ts).toISOString().slice(11, 16)

  const roomsFor = (name: string): Room[] => allRooms().filter((r) => r.members.includes(name))

  const msgLine = (room: Room, m: Message) => `#${room.id} [${clock(m.ts)}] ${m.from}: ${m.text}`

  const roomTotal = (room: Room) => room.first + room.messages.length

  const unseenFor = (rec: AgentRecord, room: Room): Message[] => {
    const cursor = Math.min(rec.reads[room.id] ?? 0, roomTotal(room))
    const start = Math.max(0, cursor - room.first)
    return room.messages.slice(start)
  }

  const markRead = (rec: AgentRecord, room: Room): AgentRecord => {
    const agents = loadAgents()
    const mine = agents[rec.sessionID] ?? rec
    mine.reads[room.id] = roomTotal(room)
    return saveRecord(mine)
  }

  const unreadCount = (rec: AgentRecord, room: Room): number => unseenFor(rec, room).length

  // ---------------------------------------------------------------- tools

  const chat_register = tool({
    description:
      "Set your unique chat name (works for both agents and subagents; yours was auto-assigned on first chat tool use). " +
      "Call with no args to see your current identity. Call with `name` to claim a unique, memorable name " +
      "(letters, digits, dash, underscore, max 32; names held by sessions that have been quiet for ~2 minutes can be reclaimed). " +
      "Other agents/subagents address you by this name in invites.",
    args: {
      name: z.string().optional().describe("New unique chat name for this agent"),
    },
    execute: async (args, ctx) => {
      const rec = ensureAgent(ctx)
      if (!args.name) {
        const rooms = roomsFor(rec.name)
        return [
          `You are "${rec.name}" (agent type: ${rec.agent}, session ${ctx.sessionID.slice(-8)}).`,
          `Status: ${rec.status || "(none — set one with chat_status)"}`,
          `Rooms: ${rooms.length ? rooms.map((r) => r.id).join(", ") : "(none — see chat_room_list)"}`,
          `To rename: chat_register(name="<new-name>"). To coordinate: chat_room_create / chat_room_join / chat_post / chat_read.`,
        ].join("\n")
      }
      const name = args.name.trim()
      if (!NAME_RE.test(name)) {
        return `Invalid name "${args.name}". Use 1-32 chars: letters, digits, dash, underscore.`
      }
      if (rec.name === name) return `You are already named "${name}".`
      const agents = loadAgents()
      const holder = Object.values(agents).find((a) => a.name === name && a.sessionID !== ctx.sessionID)
      if (holder) {
        if (await sessionAlive(holder.sessionID)) {
          return `Name "${name}" is already taken by another active agent. Pick another (see chat_agents).`
        }
        // The liveness check above is an await point: another process may
        // have reclaimed the name in the meantime. Re-check against fresh
        // state before touching anything.
        const fresh = loadAgents()
        if (
          Object.values(fresh).some(
            (a) => a.name === name && a.sessionID !== ctx.sessionID && a.sessionID !== holder.sessionID,
          )
        ) {
          return `Name "${name}" was claimed by another agent while you were checking. Pick another.`
        }
        purgeRecord(holder.sessionID)
      }
      const old = rec.name
      rec.name = name
      saveRecord(rec)
      for (const room of allRooms()) {
        let dirty = false
        if (room.members.includes(old)) {
          room.members = room.members.map((m) => (m === old ? name : m))
          dirty = true
        }
        if (room.invites.includes(old)) {
          room.invites = room.invites.map((m) => (m === old ? name : m))
          dirty = true
        }
        if (dirty) writeJSON(roomFile(room.id), room)
      }
      return `Renamed "${old}" -> "${name}". Room memberships carried over; old names remain in message history.`
    },
  })

  const chat_agents = tool({
    description:
      "List every agent and subagent in this project's agentchat directory: unique name, session liveness, " +
      "agent type, what it is doing (its status summary), its most recent activity, and which rooms it is in. " +
      "Liveness is lease-based: sessions that have gone quiet for ~2 minutes are shown as exited, so finished " +
      "subagents disappear from the directory automatically while idle-but-open persistent sessions stay alive. " +
      "Use this to find who to invite to a room or who to ask for help.",
    args: {},
    execute: async (_args, ctx) => {
      const me = ensureAgent(ctx)
      const list = Object.values(loadAgents()).sort((a, b) => a.name.localeCompare(b.name))
      if (list.length === 1) {
        return [
          `You are the only agent/subagent registered so far: "${me.name}" (type ${me.agent}).`,
          "Others appear here as soon as they use any chat tool.",
        ].join("\n")
      }
      const lines: string[] = []
      for (const a of list) {
        const alive = await sessionAlive(a.sessionID)
        const act = activity.get(a.sessionID)
        const doing =
          a.status || (act ? `active (last tool: ${act.tool}, ${ago(act.ts)})` : alive ? "idle" : "-")
        const rooms = roomsFor(a.name).map((r) => r.id)
        const status = a.sessionID === me.sessionID ? "alive (you)" : alive ? "alive" : "exited"
        const seenAt = Math.max(a.lastSeen ?? 0, act?.ts ?? 0, a.statusAt ?? 0)
        lines.push(
          [
            `- ${a.name} [type: ${a.agent}]`,
            `  liveness: ${status}`,
            `  doing: ${doing}`,
            `  last seen: ${seenAt ? ago(seenAt) : "never"}`,
            `  rooms: ${rooms.length ? rooms.join(", ") : "(none)"}`,
          ].join("\n"),
        )
      }
      return lines.join("\n")
    },
  })

  const chat_status = tool({
    description:
      "Publish a one-line summary of what you (an agent or subagent) are currently doing, so other " +
      "agents and subagents can see it via chat_agents. " +
      "Update it at meaningful milestones (starting a task, blocked, finished). Keep it short.",
    args: {
      status: z.string().describe('Short summary, e.g. "implementing auth middleware" or "blocked: need API schema"'),
    },
    execute: async (args, ctx) => {
      const rec = ensureAgent(ctx)
      rec.status = args.status.trim().slice(0, 200)
      rec.statusAt = Date.now()
      saveRecord(rec)
      return `Status updated: "${rec.status}"`
    },
  })

  const chat_room_create = tool({
    description:
      "Create a project chat room (works for agents and subagents alike) with a stated purpose " +
      "(who it is for, what it is about). " +
      "You automatically join it. Invite the agents/subagents you want with chat_invite. The room id is the " +
      "lowercased name slug; creation fails if that id already exists.",
    args: {
      name: z.string().describe('Short room name, e.g. "auth-refactor"'),
      purpose: z.string().describe('What this room is for, e.g. "coordinate the JWT -> session-cookie migration"'),
    },
    execute: async (args, ctx) => {
      const rec = ensureAgent(ctx)
      const id = slug(args.name)
      const existing = allRooms().find((r) => r.id === id)
      if (existing) {
        if (existing.purpose === args.purpose.trim()) {
          return `Room "${existing.name}" already exists with that purpose. Join it: chat_room_join(room="${existing.id}")`
        }
        return `Room id "${id}" is taken (name: ${existing.name}, purpose: ${existing.purpose}). Choose another name or join it.`
      }
      const room: Room = {
        id,
        name: args.name.trim().slice(0, 80),
        purpose: args.purpose.trim(),
        createdBy: rec.name,
        createdAt: Date.now(),
        first: 0,
        members: [rec.name],
        invites: [],
        messages: [],
      }
      pushMessage(room, rec.name, `created room — purpose: ${args.purpose.trim()}`)
      writeJSON(roomFile(id), room)
      return `Created room "${room.name}" (id: ${room.id}) and joined you. Invite agents with chat_invite(room="${room.id}", agents=[...]); they will see the invite in chat_room_list.`
    },
  })

  const chat_room_list = tool({
    description:
      "List all chat rooms in this project (available to your agent/subagent session): name, purpose, " +
      "members, message count, last message, " +
      "and your unread count. Also shows rooms you have been invited to. Join with chat_room_join.",
    args: {},
    execute: async (_args, ctx) => {
      const rec = ensureAgent(ctx)
      const rooms = allRooms().sort((a, b) => a.createdAt - b.createdAt)
      const invited = rooms.filter((r) => r.invites.includes(rec.name) && !r.members.includes(rec.name))
      if (!rooms.length) return "No rooms exist yet. Create one with chat_room_create(name, purpose)."
      const lines = rooms.map((r) => {
        const mine = r.members.includes(rec.name)
        const unread = mine ? unreadCount(rec, r) : 0
        const last = r.messages[r.messages.length - 1]
        const flags = [
          mine ? "member" : invited.includes(r) ? "INVITED" : "",
          unread ? `${unread} unread` : "",
        ]
          .filter(Boolean)
          .join(", ")
        return [
          `- ${r.id} ("${r.name}")${flags ? ` [${flags}]` : ""}`,
          `  purpose: ${r.purpose}`,
          `  members (${r.members.length}): ${r.members.join(", ") || "(none)"}`,
          `  messages: ${r.messages.length}${last ? ` — last: ${last.from}: ${last.text.slice(0, 80)}` : ""}`,
        ].join("\n")
      })
      return lines.join("\n")
    },
  })

  const chat_room_join = tool({
    description:
      "Join a chat room (by id or name) as this agent/subagent. Accepts any pending invitation for you. " +
      "Returns any messages you have not read.",
    args: {
      room: z.string().describe("Room id or name (see chat_room_list)"),
    },
    execute: async (args, ctx) => {
      const rec = ensureAgent(ctx)
      const resolved = resolveRoom(args.room)
      if (!resolved) return roomListError(args.room)
      const wasMember = resolved.members.includes(rec.name)
      let acceptedInvite = false
      if (!wasMember) {
        mutateRoom(resolved.id, (r) => {
          if (!r.members.includes(rec.name)) r.members.push(rec.name)
          if (r.invites.includes(rec.name)) {
            r.invites = r.invites.filter((n) => n !== rec.name)
            acceptedInvite = true
          }
        })
      }
      const room = loadRoom(resolved.id) ?? resolved
      const unseen = unseenFor(rec, room)
      markRead(rec, room)
      const header = acceptedInvite
        ? `Accepted invitation and joined "${room.name}" (id: ${room.id}). Purpose: ${room.purpose}`
        : wasMember
          ? `Already a member of "${room.name}" (id: ${room.id}).`
          : `Joined "${room.name}" (id: ${room.id}). Purpose: ${room.purpose}`
      if (!unseen.length) return `${header}\nNo new messages.`
      return `${header}\n${unseen.length} message(s):\n${unseen.map((m) => msgLine(room, m)).join("\n")}`
    },
  })

  const chat_invite = tool({
    description:
      "Invite other agents or subagents to a room you are a member of. Invited agents/subagents see the " +
      "invitation in chat_room_list and accept it by calling chat_room_join. Use chat_agents to find agent names.",
    args: {
      room: z.string().describe("Room id or name"),
      agents: z.array(z.string()).describe("Chat names of agents to invite (see chat_agents)"),
    },
    execute: async (args, ctx) => {
      const rec = ensureAgent(ctx)
      const resolved = resolveRoom(args.room)
      if (!resolved) return roomListError(args.room)
      if (!resolved.members.includes(rec.name)) {
        return `You must be a member of "${resolved.id}" to invite others. Join it first: chat_room_join(room="${resolved.id}")`
      }
      const agents = loadAgents()
      const byName = new Map(Object.values(agents).map((a) => [a.name, a]))
      const done: string[] = []
      const failed: string[] = []
      for (const target of args.agents) {
        const t = target.trim()
        if (resolved.members.includes(t)) {
          failed.push(`${t}: already a member`)
          continue
        }
        const holder = byName.get(t)
        if (!holder) {
          failed.push(`${t}: not a registered agent (check chat_agents)`)
          continue
        }
        if (!(await sessionAlive(holder.sessionID))) {
          failed.push(`${t}: session has exited`)
          continue
        }
        mutateRoom(resolved.id, (r) => {
          if (!r.invites.includes(t) && !r.members.includes(t)) r.invites.push(t)
        })
        done.push(t)
      }
      if (done.length) {
        mutateRoom(resolved.id, (r) => pushMessage(r, rec.name, `invited ${done.join(", ")} to this room`))
      }
      const parts: string[] = []
      if (done.length) parts.push(`Invited: ${done.join(", ")}. They accept by calling chat_room_join(room="${resolved.id}").`)
      if (failed.length) parts.push(`Not invited:\n${failed.map((f) => `  - ${f}`).join("\n")}`)
      return parts.join("\n")
    },
  })

  const chat_post = tool({
    description:
      "Post a message to a chat room you are a member of. All members (agents and subagents) see it when " +
      "they chat_read the room. " +
      "Use for coordination: progress notes, requests, findings, handoffs.",
    args: {
      room: z.string().describe("Room id or name"),
      message: z.string().describe("Message text"),
    },
    execute: async (args, ctx) => {
      const rec = ensureAgent(ctx)
      const resolved = resolveRoom(args.room)
      if (!resolved) return roomListError(args.room)
      if (!resolved.members.includes(rec.name)) {
        return `You are not a member of "${resolved.id}". Join first: chat_room_join(room="${resolved.id}")`
      }
      let posted: Message | undefined
      const room =
        mutateRoom(resolved.id, (r) => {
          if (!r.members.includes(rec.name)) r.members.push(rec.name)
          posted = pushMessage(r, rec.name, args.message)
        }) ?? resolved
      if (posted) markRead(rec, room)
      return `Posted to #${room.id} as ${rec.name}: ${posted?.text ?? args.message}`
    },
  })

  const chat_read = tool({
    description:
      "Read a chat room's messages (as this agent/subagent). By default returns only messages you have " +
      "not read yet; " +
      "pass include_read=true to reread the full retained history. Marks them read so the next " +
      "call only shows new ones.",
    args: {
      room: z.string().describe("Room id or name"),
      include_read: z.boolean().optional().describe("Reread the retained history, not just unread messages"),
    },
    execute: async (args, ctx) => {
      const rec = ensureAgent(ctx)
      const room = resolveRoom(args.room)
      if (!room) return roomListError(args.room)
      if (!room.members.includes(rec.name)) {
        return `You are not a member of "${room.id}". Join first: chat_room_join(room="${room.id}")`
      }
      const unseen = unseenFor(rec, room)
      markRead(rec, room)
      const shown = args.include_read ? room.messages : unseen
      if (!shown.length) return `#${room.id}: no new messages. (${roomTotal(room)} total, ${room.messages.length} retained)`
      const header = `#${room.id} — ${shown.length} message(s)` + (unseen.length && !args.include_read ? " (new)" : "")
      return `${header}\n${shown.map((m) => msgLine(room, m)).join("\n")}`
    },
  })

  const chat_spawn = tool({
    description:
      "Spawn a NEW persistent opencode session in a new zellij tab (your terminal must be running inside zellij). " +
      "The new session joins the project's agentchat directory under the given name (deterministic) and stays " +
      "reachable in chat rooms even while idle, outliving your current agent/subagent. " +
      "Talk to it with chat_post / chat_read and see it in chat_agents.",
    args: {
      name: z.string().describe("Unique chat name for the spawned worker (letters, digits, dash, underscore, max 32)"),
      prompt: z.string().optional().describe("Initial instruction for the worker (default: coordinate via the chat tools)"),
      room: z.string().optional().describe("Room id or name the worker auto-joins on start"),
    },
    execute: async (args, ctx) => {
      ensureAgent(ctx)
      const name = args.name.trim()
      if (!NAME_RE.test(name)) {
        return `Invalid name "${args.name}". Use 1-32 chars: letters, digits, dash, underscore.`
      }
      if (!process.env.ZELLIJ) {
        return "chat_spawn requires zellij: start zellij, then run this from inside a zellij pane/tab."
      }
      let room: Room | undefined
      if (args.room && args.room.trim()) {
        room = resolveRoom(args.room.trim())
        if (!room) return roomListError(args.room)
      }
      const holder = Object.values(loadAgents()).find((a) => a.name === name && a.sessionID !== ctx.sessionID)
      if (holder) {
        if (await sessionAlive(holder.sessionID)) {
          return `Name "${name}" is held by a live agent. Pick another name, or reuse it once it has been quiet for ~2 minutes.`
        }
        const fresh = loadAgents()
        if (
          Object.values(fresh).some(
            (a) => a.name === name && a.sessionID !== ctx.sessionID && a.sessionID !== holder.sessionID,
          )
        ) {
          return `Name "${name}" was claimed by another agent while you were checking. Pick another.`
        }
        purgeRecord(holder.sessionID)
      }
      const prompt =
        (args.prompt && args.prompt.trim()) ||
        `Act as the persistent project worker registered as "${name}". Use the chat tools (chat_room_list, chat_room_join, chat_status, chat_post, chat_read) to coordinate; stay available to take tasks.`
      const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
      // Real zellij+opencode surface (verified live on opencode 1.18.29 /
      // zellij 0.44.3): the TUI positional arg is a PROJECT PATH, not a
      // message — pass the initial instruction via `--prompt`, and export the
      // identity vars so the interactive session (which IS the worker)
      // registers under them. `run; exec tui` handoffs proved flaky; one
      // process, one tab, stays open afterwards.
      const envExports = `export AGENTCHAT_NAME=${shq(name)}${room ? ` AGENTCHAT_ROOM=${shq(room.id)}` : ""}`
      const inner = `cd -- ${shq(worktree)} && ${envExports}; exec opencode . --prompt ${shq(prompt)}`
      // execFile does NOT shell-parse argv elements: pass RAW tokens. shq is
      // only meaningful for values embedded INSIDE the zsh script (`inner`),
      // which zsh itself parses. (Passing shq'd tokens in argv made zsh exec a
      // literal quoted string as the program name — pane died instantly.)
      const argv = ["zellij", "action", "new-tab", "--name", name, "--", "zsh", "-lc", inner]
      const cmdText = `zellij action new-tab --name ${shq(name)} -- zsh -lc ${shq(inner)}`
      if (!shellHandle) {
        return `[dry-run: this process has no inline zellij runner]\nwould run: ${cmdText}`
      }
      // Deliberately NOT BunShell ($`...`): a string substituted into Bun
      // Shell's command position becomes ONE argv element ("command not found:
      // <whole string>"), and its rejection carries a Buffer stderr, not a
      // callable. execFile with an argv array has no shell-parsing surface at
      // all; `shellHandle`'s presence only serves as a "real opencode host"
      // sentinel so headless test harnesses keep the dry-run path.
      try {
        await new Promise<void>((resolve, reject) => {
          execFile(argv[0], argv.slice(1), { cwd: worktree }, (err) => (err ? reject(err) : resolve()))
        })
      } catch (e: any) {
        const code = typeof e?.code === "number" ? e.code : 1
        const errText = String(e?.stderr ?? e?.message ?? "").slice(0, 500).trim()
        return `zellij failed (exit ${code}): ${errText}`
      }
      const head = `Spawned persistent worker "${name}" in a new zellij tab. It registers under AGENTCHAT_NAME on its first chat tool use.${room ? ` Auto-joined room "${room.id}".` : ""}`
      return `${head}\nTalk to it with chat_post / chat_read; watch it in chat_agents.`
    },
  })

  return {
    tool: {
      chat_register,
      chat_agents,
      chat_status,
      chat_room_create,
      chat_room_list,
      chat_room_join,
      chat_invite,
      chat_post,
      chat_read,
      chat_spawn,
    },

    event: async ({ event }: { event: { type: string; properties?: any } }) => {
      const live = eventSessionID(event)
      if (live) markSeen(live)
      if (event.type === "session.deleted") {
        const id: string | undefined = event.properties?.info?.id ?? event.properties?.sessionID
        if (!id) return
        deadCache.add(id)
        activity.delete(id)
        seen.delete(id)
        const agents = loadAgents()
        if (agents[id]) {
          delete agents[id]
          writeJSON(agentsFile(), agents)
        }
      }
    },

    // Track what each session is doing, for chat_agents. Fires for all
    // registered tools including this plugin's own.
    "tool.execute.before": async (input: { tool: string; sessionID: string }) => {
      activity.set(input.sessionID, { tool: input.tool, ts: Date.now() })
      if (activity.size > MAX_ACTIVITY) {
        const oldest = activity.keys().next().value
        if (oldest !== undefined && oldest !== input.sessionID) activity.delete(oldest)
      }
      deadCache.delete(input.sessionID)
      markSeen(input.sessionID)
      void classifySelf(input.sessionID)
    },

    // Advertise the coordination system (and the caller's identity) in the
    // system prompt so every agent knows the chat tools exist.
    "experimental.chat.system.transform": async (input: { sessionID?: string }, output: { system: string[] }) => {
      if (input.sessionID) {
        markSeen(input.sessionID)
        void classifySelf(input.sessionID)
      }
      const lines = [
        "# Agent coordination (agentchat)",
        "Chat tools are available so agents and subagents working on this project can coordinate instead of working blind:",
        "- chat_agents: directory of every agent/subagent, its unique name, live/exited status, and what it is doing.",
        "- chat_room_create(name, purpose) / chat_room_list / chat_room_join: project chat rooms by topic.",
        "- chat_invite(room, agents): pull other agents/subagents into your room.",
        "- chat_post / chat_read: exchange messages in rooms you are a member of.",
        "- chat_status(status): publish what you are doing so others can see it.",
        "- chat_register(name): claim or check your unique chat name.",
        "- chat_spawn(name, ...): start a persistent worker session in a new zellij tab.",
      ]
      if (input.sessionID) {
        const rec = loadAgents()[input.sessionID]
        if (rec) {
          lines.push(`You are registered as "${rec.name}". Run chat_room_list to see rooms relevant to your task and join them.`)
        } else {
          lines.push("You are automatically registered under a unique name the first time you use any chat_* tool.")
        }
      }
      const block = lines.join("\n")
      const parts = output.system.map((s) => s.trim()).filter((s) => s.length > 0)
      // opencode maps every system entry to its own system-role message;
      // SGLang/vLLM reject a system message that isn't the first one
      // ("System message must be at the beginning."). Always collapse to a
      // single system message.
      if (parts.length === 0) output.system.push(block)
      else output.system.splice(0, output.system.length, parts.concat(block).join("\n\n"))
    },
  }
}) satisfies Plugin
