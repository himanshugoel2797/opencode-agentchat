// opencode-agentchat — chat rooms for agents and subagents working together.
//
// Every agent session (primary or subagent) gets a unique name, can create
// and list chat rooms (each with a stated purpose), invite other agents,
// join rooms, exchange messages, and see a live directory of what every
// agent is doing.
//
// State lives in <project>/.agentchat/ so it is shared by all sessions on
// the project and survives restarts.

import * as fs from "node:fs"
import * as path from "node:path"
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
  reads: Record<string, number>
}

type Message = {
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
  members: string[]
  invites: string[]
  messages: Message[]
}

const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/
const MAX_MESSAGES = 1000

export default (async ({ worktree }: { worktree: string }) => {
  const root = path.join(worktree, ".agentchat")
  const roomsDir = path.join(root, "rooms")

  // In-memory activity log, fed by tool.execute.before. Keyed by sessionID.
  const activity = new Map<string, { tool: string; ts: number }>()

  const ensureDirs = () => {
    fs.mkdirSync(roomsDir, { recursive: true })
  }

  const readJSON = <T,>(file: string, fallback: T): T => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as T
    } catch {
      return fallback
    }
  }

  const writeJSON = (file: string, data: unknown) => {
    ensureDirs()
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
    fs.renameSync(tmp, file)
  }

  const agentsFile = () => path.join(root, "agents.json")

  const loadAgents = (): Record<string, AgentRecord> => readJSON(agentsFile(), {})

  const saveAgents = (agents: Record<string, AgentRecord>) => writeJSON(agentsFile(), agents)

  const takenNames = (agents: Record<string, AgentRecord>): Set<string> =>
    new Set(Object.values(agents).map((a) => a.name))

  const sanitize = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 24) || "agent"

  // Lazily register the calling session under a unique default name.
  const ensureAgent = (ctx: ToolContext): AgentRecord => {
    const agents = loadAgents()
    const existing = agents[ctx.sessionID]
    if (existing) return existing
    const taken = takenNames(agents)
    let name = `${sanitize(ctx.agent)}-${ctx.sessionID.slice(-4)}`
    let n = 2
    while (taken.has(name)) name = `${sanitize(ctx.agent)}-${ctx.sessionID.slice(-4)}-${n++}`
    const rec: AgentRecord = {
      sessionID: ctx.sessionID,
      name,
      agent: ctx.agent,
      status: "",
      statusAt: 0,
      registeredAt: Date.now(),
      reads: {},
    }
    agents[ctx.sessionID] = rec
    saveAgents(agents)
    return rec
  }

  const findByName = (name: string): AgentRecord | undefined =>
    Object.values(loadAgents()).find((a) => a.name === name)

  const roomFile = (id: string) => path.join(roomsDir, `${id}.json`)

  const loadRoom = (id: string): Room | undefined => {
    try {
      return readJSON<Room>(roomFile(id), undefined as unknown as Room)
    } catch {
      return undefined
    }
  }

  const saveRoom = (room: Room) => writeJSON(roomFile(room.id), room)

  const allRooms = (): Room[] => {
    try {
      return fs
        .readdirSync(roomsDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => readJSON<Room>(path.join(roomsDir, f), undefined as unknown as Room))
        .filter((r) => r && r.id)
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

  const unreadFor = (rec: AgentRecord, room: Room): number =>
    room.messages.length - (rec.reads[room.id] ?? 0)

  // ---------------------------------------------------------------- tools

  const chat_register = tool({
    description:
      "Set your unique chat name (agents/subagents each have one; yours was auto-assigned on first chat tool use). " +
      "Call with no args to see your current identity. Call with `name` to claim a unique, memorable name " +
      "(letters, digits, dash, underscore, max 32). Other agents address you by this name in invites.",
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
      const agents = loadAgents()
      if (takenNames(agents).has(name) && rec.name !== name) {
        return `Name "${name}" is already taken by another agent. Pick another (see chat_agents).`
      }
      if (rec.name !== name) {
        const old = rec.name
        rec.name = name
        agents[ctx.sessionID] = rec
        saveAgents(agents)
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
          if (dirty) saveRoom(room)
        }
        return `Renamed "${old}" -> "${name}". Room memberships carried over; old names remain in message history.`
      }
      return `You are already named "${name}".`
    },
  })

  const chat_agents = tool({
    description:
      "List every agent/subagent currently participating in agentchat: unique name, agent type, " +
      "what it is doing (its status summary), its most recent activity, and which rooms it is in. " +
      "Use this to find who to invite to a room or who to ask for help.",
    args: {},
    execute: async (_args, ctx) => {
      const me = ensureAgent(ctx)
      const agents = loadAgents()
      const list = Object.values(agents).sort((a, b) => a.name.localeCompare(b.name))
      if (list.length === 1) {
        return [
          `You are the only agent registered so far: "${me.name}" (type ${me.agent}).`,
          "Other agents appear here as soon as they use any chat tool.",
        ].join("\n")
      }
      return list
        .map((a) => {
          const act = activity.get(a.sessionID)
          const doing =
            a.status || (act ? `active (last tool: ${act.tool}, ${ago(act.ts)})` : "idle")
          const rooms = roomsFor(a.name).map((r) => r.id)
          return [
            `- ${a.name}${a.sessionID === me.sessionID ? " (you)" : ""} [type: ${a.agent}]`,
            `  doing: ${doing}`,
            `  last seen: ${ago(Math.max(a.statusAt, act?.ts ?? 0))}`,
            `  rooms: ${rooms.length ? rooms.join(", ") : "(none)"}`,
          ].join("\n")
        })
        .join("\n")
    },
  })

  const chat_status = tool({
    description:
      "Publish a one-line summary of what you are currently doing, so other agents can see it via chat_agents. " +
      "Update it at meaningful milestones (starting a task, blocked, finished). Keep it short.",
    args: {
      status: z.string().describe('Short summary, e.g. "implementing auth middleware" or "blocked: need API schema"'),
    },
    execute: async (args, ctx) => {
      const rec = ensureAgent(ctx)
      const agents = loadAgents()
      rec.status = args.status.trim().slice(0, 200)
      rec.statusAt = Date.now()
      agents[ctx.sessionID] = rec
      saveAgents(agents)
      return `Status updated: "${rec.status}"`
    },
  })

  const chat_room_create = tool({
    description:
      "Create a project chat room with a stated purpose (who it is for, what it is about). " +
      "You automatically join it. Invite the agents you want with chat_invite. Fails if a room " +
      "with the same name and purpose already exists.",
    args: {
      name: z.string().describe('Short room name, e.g. "auth-refactor"'),
      purpose: z.string().describe("What this room is for, e.g. \"coordinate the JWT -> session-cookie migration\""),
    },
    execute: async (args, ctx) => {
      const rec = ensureAgent(ctx)
      const id = slug(args.name)
      const existing = allRooms().find((r) => r.id === id)
      if (existing) {
        if (existing.purpose === args.purpose.trim()) {
          return `Room "${existing.name}" already exists with that purpose. Join it: chat_room_join(room="${existing.id}")`
        }
        return `Room name "${args.name}" is taken (id: ${existing.id}, purpose: ${existing.purpose}). Choose another name or join it.`
      }
      const room: Room = {
        id,
        name: args.name.trim().slice(0, 80),
        purpose: args.purpose.trim(),
        createdBy: rec.name,
        createdAt: Date.now(),
        members: [rec.name],
        invites: [],
        messages: [
          {
            i: 0,
            ts: Date.now(),
            from: rec.name,
            text: `created room — purpose: ${args.purpose.trim()}`,
          },
        ],
      }
      saveRoom(room)
      return `Created room "${room.name}" (id: ${room.id}) and joined you. Invite agents with chat_invite(room="${room.id}", agents=[...]); they will see the invite in chat_room_list.`
    },
  })

  const chat_room_list = tool({
    description:
      "List all chat rooms in this project: name, purpose, members, message count, last message, " +
      "and your unread count. Also shows rooms you have been invited to. Join with chat_room_join.",
    args: {},
    execute: async (_args, ctx) => {
      const rec = ensureAgent(ctx)
      const rooms = allRooms().sort((a, b) => a.createdAt - b.createdAt)
      const invited = rooms.filter((r) => r.invites.includes(rec.name) && !r.members.includes(rec.name))
      if (!rooms.length) return "No rooms exist yet. Create one with chat_room_create(name, purpose)."
      const lines = rooms.map((r) => {
        const mine = r.members.includes(rec.name)
        const unread = mine ? unreadFor(rec, r) : 0
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
      "Join a chat room (by id or name). Accepts any pending invitation for you. " +
      "Returns any unread messages you missed in the room.",
    args: {
      room: z.string().describe("Room id or name (see chat_room_list)"),
    },
    execute: async (args, ctx) => {
      const rec = ensureAgent(ctx)
      const room = resolveRoom(args.room)
      if (!room) return roomListError(args.room)
      let acceptedInvite = false
      if (!room.members.includes(rec.name)) {
        room.members.push(rec.name)
        if (room.invites.includes(rec.name)) {
          room.invites = room.invites.filter((n) => n !== rec.name)
          acceptedInvite = true
        }
        saveRoom(room)
      }
      const agents = loadAgents()
      const unseen = room.messages.slice(rec.reads[room.id] ?? 0)
      rec.reads[room.id] = room.messages.length
      agents[ctx.sessionID] = rec
      saveAgents(agents)
      const header = acceptedInvite
        ? `Accepted invitation and joined "${room.name}" (id: ${room.id}). Purpose: ${room.purpose}`
        : `Joined "${room.name}" (id: ${room.id}). Purpose: ${room.purpose}`
      if (!unseen.length) return `${header}\nNo messages yet.`
      return `${header}\n${unseen.length} message(s):\n${unseen.map((m) => msgLine(room, m)).join("\n")}`
    },
  })

  const chat_invite = tool({
    description:
      "Invite other agents to a room you are a member of. Invited agents see the invitation in " +
      "chat_room_list and accept it by calling chat_room_join. Use chat_agents to find agent names.",
    args: {
      room: z.string().describe("Room id or name"),
      agents: z.array(z.string()).describe("Chat names of agents to invite (see chat_agents)"),
    },
    execute: async (args, ctx) => {
      const rec = ensureAgent(ctx)
      const room = resolveRoom(args.room)
      if (!room) return roomListError(args.room)
      if (!room.members.includes(rec.name)) {
        return `You must be a member of "${room.id}" to invite others. Join it first: chat_room_join(room="${room.id}")`
      }
      const known = takenNames(loadAgents())
      const done: string[] = []
      const failed: string[] = []
      for (const target of args.agents) {
        const t = target.trim()
        if (room.members.includes(t)) {
          failed.push(`${t}: already a member`)
          continue
        }
        if (!known.has(t)) {
          failed.push(`${t}: not a registered agent (check chat_agents)`)
          continue
        }
        if (!room.invites.includes(t)) room.invites.push(t)
        done.push(t)
      }
      if (done.length) {
        room.messages.push({
          i: room.messages.length,
          ts: Date.now(),
          from: rec.name,
          text: `invited ${done.join(", ")} to this room`,
        })
        saveRoom(room)
      }
      const parts = []
      if (done.length) parts.push(`Invited: ${done.join(", ")}. They accept by calling chat_room_join(room="${room.id}").`)
      if (failed.length) parts.push(`Not invited:\n${failed.map((f) => `  - ${f}`).join("\n")}`)
      return parts.join("\n")
    },
  })

  const chat_post = tool({
    description:
      "Post a message to a chat room you are a member of. All members see it when they chat_read the room. " +
      "Use for coordination: progress notes, requests, findings, handoffs.",
    args: {
      room: z.string().describe("Room id or name"),
      message: z.string().describe("Message text"),
    },
    execute: async (args, ctx) => {
      const rec = ensureAgent(ctx)
      const room = resolveRoom(args.room)
      if (!room) return roomListError(args.room)
      if (!room.members.includes(rec.name)) {
        return `You are not a member of "${room.id}". Join first: chat_room_join(room="${room.id}")`
      }
      const m: Message = {
        i: room.messages.length,
        ts: Date.now(),
        from: rec.name,
        text: args.message.trim().slice(0, 4000),
      }
      room.messages.push(m)
      if (room.messages.length > MAX_MESSAGES) {
        const cut = room.messages.length - MAX_MESSAGES
        room.messages = room.messages.slice(cut)
        room.messages.forEach((x, idx) => (x.i = idx))
      }
      saveRoom(room)
      const agents = loadAgents()
      const r = agents[ctx.sessionID]
      if (r) {
        r.reads[room.id] = room.messages.length
        saveAgents(agents)
      }
      return `Posted to #${room.id} as ${rec.name}: ${m.text}`
    },
  })

  const chat_read = tool({
    description:
      "Read a chat room's messages. By default returns only messages you have not read yet; " +
      "pass include_read=true to reread the full history. Marks them read so the next call only shows new ones.",
    args: {
      room: z.string().describe("Room id or name"),
      include_read: z.boolean().optional().describe("Reread the entire history, not just unread messages"),
    },
    execute: async (args, ctx) => {
      const rec = ensureAgent(ctx)
      const room = resolveRoom(args.room)
      if (!room) return roomListError(args.room)
      if (!room.members.includes(rec.name)) {
        return `You are not a member of "${room.id}". Join first: chat_room_join(room="${room.id}")`
      }
      const agents = loadAgents()
      const mine = agents[ctx.sessionID]
      const unseen = room.messages.slice(mine.reads[room.id] ?? 0)
      mine.reads[room.id] = room.messages.length
      saveAgents(agents)
      const shown = args.include_read ? room.messages : unseen
      if (!shown.length) return `#${room.id}: no new messages. (${room.messages.length} total in history)`
      const header = `#${room.id} — ${shown.length} message(s)` + (unseen.length && !args.include_read ? " (new)" : "")
      return `${header}\n${shown.map((m) => msgLine(room, m)).join("\n")}`
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
    },

    // Track what each registered session is doing, for chat_agents.
    "tool.execute.before": async (input: { tool: string; sessionID: string }) => {
      activity.set(input.sessionID, { tool: input.tool, ts: Date.now() })
    },

    // Advertise the coordination system (and the caller's identity) in the
    // system prompt so every agent knows the chat tools exist.
    "experimental.chat.system.transform": async (input: { sessionID?: string }, output: { system: string[] }) => {
      if (input.sessionID) {
        const rec = loadAgents()[input.sessionID]
        if (rec) activity.set(rec.sessionID, { tool: "chat-system", ts: Date.now() })
      }
      output.system.push(
        [
          "# Agent coordination (agentchat)",
          "Multiple agents are working in this project. Coordinate instead of working blind:",
          "- chat_agents: directory of every agent, its unique name, and what it is doing.",
          "- chat_room_create(name, purpose) / chat_room_list / chat_room_join: project chat rooms by topic.",
          "- chat_invite(room, agents): pull other agents into your room.",
          "- chat_post / chat_read: exchange messages in rooms you are a member of.",
          "- chat_status(status): publish what you are doing so others can see it.",
          "- chat_register(name): claim a memorable unique name.",
          "If your session has been registered, your chat name is stated above; run chat_register with no args to check. " +
          "Check chat_room_list for rooms relevant to your task and join them; post status updates at milestones.",
        ].join("\n"),
      )
    },
  }
}) satisfies Plugin
