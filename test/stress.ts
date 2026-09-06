// Adversarial stress / edge-case suite for opencode-agentchat.
//
// Mirrors test/smoke.ts (fake ToolContexts driving real tool execute fns) but:
//  - instantiates the plugin MULTIPLE TIMES against the SAME temp worktree to
//    simulate distinct opencode processes (own deadCache/activity, shared disk),
//  - drives tools via Promise.all so the awaits inside chat_register /
//    chat_invite / chat_agents interleave instance execution (race surface),
//  - marks genuine plugin races as XFAIL (see test/FINDINGS-STRESS.md) so the
//    suite stays green until the plugin is fixed centrally.
//
// Run: npx tsx test/stress.ts   (exit 0 = all checks passed or xfailed)

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { ToolContext } from "@opencode-ai/plugin"
import AgentChat from "../index.ts"

// global watchdog: suite must stay well under 60s
const watchdog = setTimeout(() => {
  console.error("SUITE TIMEOUT (>55s) — aborting")
  process.exit(2)
}, 55000)
watchdog.unref()

// ---------------------------------------------------------------- framework

type Status = "PASS" | "FAIL" | "XFAIL"
const results: { id: string; name: string; status: Status; note: string }[] = []
let failures = 0

function record(id: string, name: string, status: Status, note = "") {
  results.push({ id, name, status, note })
  const tag = status === "FAIL" ? "FAIL" : status === "XFAIL" ? "XFAIL" : "PASS"
  console.log(`[${tag}] ${id} ${name}${note ? `\n        note: ${note}` : ""}`)
  if (status === "FAIL") failures++
}
function check(id: string, name: string, cond: boolean, failNote = "") {
  record(id, name, cond ? "PASS" : "FAIL", cond ? "" : failNote)
}
// Documents a known/suspected plugin bug: bug reproduced -> XFAIL (green);
// not reproduced -> PASS with note. Never fails the suite.
function xcheck(id: string, name: string, bugObserved: boolean, bugNote: string, okNote = "race did not reproduce") {
  record(id, name, bugObserved ? "XFAIL" : "PASS", bugObserved ? bugNote : okNote)
}

// ---------------------------------------------------------------- helpers

type Exec = (args: any, ctx: ToolContext) => Promise<string>

function makeClient(delayMs = 0) {
  const alive = new Set<string>()
  const throwing = new Set<string>()
  let delay = delayMs
  const client = {
    session: {
      get: async ({ path: { id } }: { path: { id: string } }) => {
        if (throwing.has(id)) throw new Error("synthetic client failure")
        if (delay > 0) await new Promise((r) => setTimeout(r, delay))
        return alive.has(id) ? { data: { id } } : { data: undefined, error: { status: 404 } }
      },
    },
  }
  return { client, alive, throwing, setDelay: (d: number) => (delay = d) }
}
type Ctrl = ReturnType<typeof makeClient>

async function makeInst(worktree: string, client: any) {
  const hooks = (await AgentChat({ worktree, client } as never)) as unknown as Record<string, any>
  const tools = hooks.tool as Record<string, { execute: Exec }>
  return {
    tools,
    exec: (name: string, args: any, ctx: ToolContext) => tools[name].execute(args, ctx),
    event: (event: { type: string; properties?: any }) => hooks.event({ event }),
    before: (input: { tool: string; sessionID: string }) => hooks["tool.execute.before"](input),
  }
}
type Inst = Awaited<ReturnType<typeof makeInst>>

function makeCtx(worktree: string) {
  return (sessionID: string, agent: string): ToolContext =>
    ({
      sessionID,
      messageID: "m1",
      agent,
      directory: worktree,
      worktree,
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {},
    }) as ToolContext
}

const mkwt = (tag: string) => fs.mkdtempSync(path.join(os.tmpdir(), `agentchat-stress-${tag}-`))
const readAgents = (wt: string) => JSON.parse(fs.readFileSync(path.join(wt, ".agentchat", "agents.json"), "utf8"))
const readRoom = (wt: string, id: string) =>
  JSON.parse(fs.readFileSync(path.join(wt, ".agentchat", "rooms", `${id}.json`), "utf8"))
const writeRoom = (wt: string, id: string, obj: unknown) => {
  fs.mkdirSync(path.join(wt, ".agentchat", "rooms"), { recursive: true })
  fs.writeFileSync(path.join(wt, ".agentchat", "rooms", `${id}.json`), JSON.stringify(obj))
}
function walk(dir: string, base = dir): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p, base))
    else out.push(path.relative(base, p))
  }
  return out.sort()
}
const count = (s: string, re: RegExp) => (s.match(re) || []).length
const msg = (i: number) => `m${i}`

// ================================================================ section 1:
// multi-instance races on one worktree (req. 1, 2, 10-join, 12, +interleave)
async function secRace() {
  console.log("\n--- section RACE ---")
  const wt = mkwt("race")
  const ctrl = makeClient()
  const I1 = await makeInst(wt, ctrl.client)
  const I2 = await makeInst(wt, ctrl.client)
  const ctx = makeCtx(wt)
  const alice = ctx("ses_race_alice_01", "alice")
  const bob = ctx("ses_race_bob_02", "bob")
  ctrl.alive.add("ses_race_alice_01").add("ses_race_bob_02")
  await I1.exec("chat_register", { name: "alice" }, alice)
  await I2.exec("chat_register", { name: "bob" }, bob)

  // [01a] concurrent chat_room_create of the same name from two instances
  const [c1, c2] = await Promise.all([
    I1.exec("chat_room_create", { name: "duel", purpose: "purpose-one" }, alice),
    I2.exec("chat_room_create", { name: "duel", purpose: "purpose-two" }, bob),
  ])
  const createdN = count(c1 + "\n" + c2, /Created room/g)
  const takenN = count(c1 + "\n" + c2, /is taken/g)
  check("01a", "concurrent create same name: exactly one creates, other gets taken-id error",
    createdN === 1 && takenN === 1, `created=${createdN} taken=${takenN} :: [${c1}] [${c2}]`)
  let duel: any
  try {
    duel = readRoom(wt, "duel")
  } catch {
    duel = null
  }
  check("01b", "concurrent create: room file intact, sole member is the winner",
    !!duel && duel.members.length === 1 && duel.createdBy === duel.members[0] &&
      ["purpose-one", "purpose-two"].includes(duel.purpose),
    `duel=${JSON.stringify(duel)}`)

  // [01c] same name + same purpose -> join hint, not a new room
  const c3 = await I2.exec("chat_room_create", { name: "duel", purpose: "purpose-one" }, bob)
  check("01c", "recreate same name+purpose -> 'already exists with that purpose' join hint",
    /already exists with that purpose/.test(c3), c3)

  // [02] interleaved concurrent posts: 50 from each instance
  await I1.exec("chat_room_create", { name: "storm", purpose: "storm test" }, alice)
  await I2.exec("chat_room_join", { room: "storm" }, bob)
  const loop = async (room: string, I: Inst, from: ToolContext, tag: string, n: number) => {
    for (let i = 1; i <= n; i++) await I.exec("chat_post", { room, message: `${tag}-${i}` }, from)
  }
  await Promise.all([loop("storm", I1, alice, "a", 50), loop("storm", I2, bob, "b", 50)])
  const storm = readRoom(wt, "storm")
  const iseq = storm.messages.every((m: any, k: number) => m.i === storm.first + k)
  const seqConsecutive = storm.messages.every((m: any, k: number, arr: any[]) => k === 0 || m.i === arr[k - 1].i + 1)
  const aN = storm.messages.filter((m: any) => m.from === "alice").length
  const bN = storm.messages.filter((m: any) => m.from === "bob").length
  check("02a", "interleaved 50+50 posts: no lost messages (creation + 100 posts retained)",
    storm.messages.length === 101 && storm.first === 0 && roomTotal(storm) === 101 && aN === 51 && bN === 50,
    `len=${storm.messages.length} first=${storm.first} a=${aN} b=${bN}`)
  check("02b", "interleaved posts: absolute i strictly consecutive, first+length consistent",
    iseq && seqConsecutive, `iseq=${iseq} consecutive=${seqConsecutive}`)

  // [CI] invite (awaits liveness) interleaved with concurrent posts on same room
  const tgt = ctx("ses_race_tgt_0003", "tgt")
  ctrl.alive.add("ses_race_tgt_0003")
  await I1.exec("chat_register", { name: "tgt" }, tgt)
  await I1.exec("chat_room_create", { name: "mix", purpose: "interleave test" }, alice)
  await I2.exec("chat_room_join", { room: "mix" }, bob)
  ctrl.setDelay(15) // force the liveness await to yield to the event loop
  const [invOut] = await Promise.all([
    I1.exec("chat_invite", { room: "mix", agents: ["tgt"] }, alice),
    loop("mix", I2, bob, "late", 10), // runs to completion while invite awaits
  ])
  ctrl.setDelay(0)
  const mix = readRoom(wt, "mix")
  const last = mix.messages[mix.messages.length - 1]
  const mixSeq = mix.messages.every((m: any, k: number, arr: any[]) => k === 0 || m.i === arr[k - 1].i + 1)
  check("CI", "invite awaiting liveness during 10 concurrent posts: no message loss, notice appended last",
    /Invited: tgt/.test(invOut) && mix.messages.length === 1 + 10 + 1 && mixSeq &&
      /invited tgt/.test(last.text) && mix.invites.includes("tgt"),
    `len=${mix.messages.length} last="${last.text}" out=${invOut}`)

  // [CM] concurrent auto-registration from two instances merges (I4)
  const m1 = ctx("ses_race_merge1_04", "m1")
  const m2 = ctx("ses_race_merge2_05", "m2")
  ctrl.alive.add("ses_race_merge1_04").add("ses_race_merge2_05")
  await Promise.all([
    I1.exec("chat_status", { status: "s1" }, m1),
    I2.exec("chat_status", { status: "s2" }, m2),
  ])
  const ag = readAgents(wt)
  check("CM", "concurrent auto-registration from 2 instances: both records survive (merge, no clobber)",
    !!ag["ses_race_merge1_04"] && !!ag["ses_race_merge2_05"] &&
      ag["ses_race_merge1_04"].name !== ag["ses_race_merge2_05"].name,
    JSON.stringify(Object.keys(ag)))

  // [10j] 3 concurrent joins of same room from 2 instances: membership stays unique
  await I1.exec("chat_room_create", { name: "joinme", purpose: "join race" }, alice)
  const joins = await Promise.all([
    I1.exec("chat_room_join", { room: "joinme" }, bob),
    I2.exec("chat_room_join", { room: "joinme" }, bob),
    I1.exec("chat_room_join", { room: "joinme" }, bob),
  ])
  const jm = readRoom(wt, "joinme")
  check("10j", "3 concurrent joins (2 instances): member listed exactly once",
    jm.members.filter((x: string) => x === "bob").length === 1 && joins.some((j) => /Joined/.test(j)),
    `members=${JSON.stringify(jm.members)}`)

  // [12a] chat_read idempotent: second read says no new
  await I1.exec("chat_room_create", { name: "idem", purpose: "read marks" }, alice)
  await I2.exec("chat_room_join", { room: "idem" }, bob)
  await I1.exec("chat_post", { room: "idem", message: "ping" }, alice)
  const r1 = await I2.exec("chat_read", { room: "idem" }, bob)
  const r2 = await I2.exec("chat_read", { room: "idem" }, bob)
  check("12a", "chat_read twice: first shows new, second says 'no new messages'",
    /ping/.test(r1) && /no new messages/.test(r2), `[${r1}] [${r2}]`)

  // [12b] chat_post auto-reads own room
  await I1.exec("chat_post", { room: "idem", message: "from alice" }, alice)
  const rA = await I1.exec("chat_read", { room: "idem" }, alice)
  check("12b", "poster auto-marks room read: chat_read right after chat_post shows no new",
    /no new messages/.test(rA), rA)

  // [12c] two readers with different cursors do not interfere
  const e1 = ctx("ses_race_e1__0006", "e1") // joins before p2
  const e2 = ctx("ses_race_e2__0007", "e2") // joins after p2 (auto-reads everything)
  ctrl.alive.add("ses_race_e1__0006").add("ses_race_e2__0007")
  await I1.exec("chat_room_join", { room: "idem" }, e1)
  await I1.exec("chat_post", { room: "idem", message: "p2" }, alice)
  await I2.exec("chat_room_join", { room: "idem" }, e2) // join burns unread
  await I1.exec("chat_post", { room: "idem", message: "p3" }, alice)
  const [x1, x2] = await Promise.all([
    I1.exec("chat_read", { room: "idem" }, e1),
    I2.exec("chat_read", { room: "idem" }, e2),
  ])
  check("12c", "independent cursors: pre-p2 member sees p2+p3, join-late member sees only p3",
    /p2/.test(x1) && /p3/.test(x1) && !/p2/.test(x2) && /p3/.test(x2) &&
      /1 message\(s\)/.test(x2),
    `[${x1}] [${x2}]`)
}
const roomTotal = (r: any) => r.first + r.messages.length

// =========================================================== section limits:
// truncation / validation edge cases (req. 10) + auto-read confirm
async function secLimits() {
  console.log("\n--- section LIMITS ---")
  const wt = mkwt("limits")
  const ctrl = makeClient()
  const I = await makeInst(wt, ctrl.client)
  const ctx = makeCtx(wt)
  const L = ctx("ses_lim_long_0001", "long")
  const M = ctx("ses_lim_mem__0002", "mem")
  ctrl.alive.add("ses_lim_long_0001").add("ses_lim_mem__0002")
  await I.exec("chat_register", { name: "lim" }, L)

  const sOut = await I.exec("chat_status", { status: "s".repeat(201) }, L)
  const statusLen: number = readAgents(wt)["ses_lim_long_0001"].status.length
  check("10a", "status truncated to exactly 200 chars",
    statusLen === 200 && /Status updated/.test(sOut), `statusLen=${statusLen}`)

  const idOut = await I.exec("chat_register", {}, L)
  const myName = (idOut.match(/You are "([^"]+)"/) || [])[1] || ""
  const same = await I.exec("chat_register", { name: myName }, L)
  check("10b", "rename to own current name is a no-op ('already named')",
    myName === "lim" && /already named/.test(same), `name=${myName} out=${same}`)

  const bad33 = await I.exec("chat_register", { name: "a".repeat(33) }, L)
  const badSp = await I.exec("chat_register", { name: "with space" }, L)
  const badEmpty = await I.exec("chat_register", { name: "   " }, L)
  check("10c", "33-char / spaced / blank names rejected",
    /Invalid name/.test(bad33) && /Invalid name/.test(badSp) && /Invalid name/.test(badEmpty),
    `[${bad33}] [${badSp}] [${badEmpty}]`)

  await I.exec("chat_room_create", { name: "solo", purpose: "sole member" }, L)
  const postOut = await I.exec("chat_post", { room: "solo", message: "y".repeat(4001) }, L)
  const solo = readRoom(wt, "solo")
  const lastMsg = solo.messages[solo.messages.length - 1]
  check("10d", "4001-char message truncated to exactly 4000 on disk",
    /Posted to #solo/.test(postOut) && lastMsg.text.length === 4000 && lastMsg.text === "y".repeat(4000),
    `len=${lastMsg.text.length}`)
  const padPost = await I.exec("chat_post", { room: "solo", message: "  padded  " }, L)
  const padded = readRoom(wt, "solo").messages[readRoom(wt, "solo").messages.length - 1]
  check("10e", "message whitespace trimmed", /Posted/.test(padPost) && padded.text === "padded", padded.text)

  const selfInvite = await I.exec("chat_invite", { room: "solo", agents: ["lim"] }, L)
  check("10f", "invite self -> 'already a member'", /already a member/.test(selfInvite), selfInvite)

  await I.exec("chat_register", { name: "mem" }, M)
  const firstInvite = await I.exec("chat_invite", { room: "solo", agents: ["mem"] }, L)
  await I.exec("chat_room_join", { room: "solo" }, M)
  const secondInvite = await I.exec("chat_invite", { room: "solo", agents: ["mem"] }, L)
  check("10g", "invite new agent succeeds; invite existing member -> 'already a member'",
    /Invited: mem/.test(firstInvite) && /already a member/.test(secondInvite),
    `[${firstInvite}] [${secondInvite}]`)

  const ghost = await I.exec("chat_invite", { room: "solo", agents: ["nope"] }, L)
  check("10h", "invite unknown name -> 'not a registered agent'", /not a registered agent/.test(ghost), ghost)

  const list = await I.exec("chat_room_list", {}, L)
  check("10i", "post/list as (one of two) members works normally", /\[member/.test(list), list)
}

// ======================================================== section liveness:
// dead/alive/throwing clients, session.deleted (req. 4, 5) — 2 instances
async function secLiveness() {
  console.log("\n--- section LIVENESS ---")
  const wt = mkwt("liveness")
  const ctrl = makeClient()
  const I1 = await makeInst(wt, ctrl.client)
  const I2 = await makeInst(wt, ctrl.client)
  const ctx = makeCtx(wt)
  const sess = {
    prim: "ses_liv_prim__0001",
    vic: "ses_liv_vic___0002",
    rec: "ses_liv_rec___0003",
    thr: "ses_liv_thr___0004",
    gon: "ses_liv_gon___0005",
    gn2: "ses_liv_gn2___0006",
    sleep: "ses_liv_sleep_007",
  }
  for (const id of Object.values(sess)) ctrl.alive.add(id)
  ctrl.throwing.add(sess.thr) // client THROWS for the thrower session
  const c = (k: keyof typeof sess, agent: string) => ctx(sess[k], agent)
  await I1.exec("chat_register", { name: "prim" }, c("prim", "build"))
  await I1.exec("chat_register", { name: "zombie" }, c("vic", "vic"))
  await I2.exec("chat_register", { name: "reclaimer" }, c("rec", "rec"))
  await I1.exec("chat_register", { name: "thrower" }, c("thr", "thr"))
  await I1.exec("chat_status", { status: "temp" }, c("gon", "gone")) // auto-registers
  await I2.exec("chat_status", { status: "temp" }, c("gn2", "gone2"))

  // lounge: zombie joins; pub: zombie registered but NOT member; dock: for thrower
  await I1.exec("chat_room_create", { name: "lounge", purpose: "hang out" }, c("prim", "build"))
  await I1.exec("chat_invite", { room: "lounge", agents: ["zombie"] }, c("prim", "build"))
  await I1.exec("chat_room_join", { room: "lounge" }, c("vic", "vic"))
  await I1.exec("chat_room_create", { name: "pub", purpose: "no zombies" }, c("prim", "build"))
  await I1.exec("chat_room_create", { name: "dock", purpose: "throwers" }, c("prim", "build"))

  // mark victim dead
  ctrl.alive.delete(sess.vic)

  const agentsOut = await I1.exec("chat_agents", {}, c("prim", "build"))
  check("04a", "dead session live-opts out of chat_agents with liveness: exited",
    /- zombie \[type: vic\]\n\s+liveness: exited/.test(agentsOut), agentsOut)
  const aliveEntry = (agentsOut.match(/- prim \[type: build\]\n\s+liveness: ([^\n]+)/) || [])[1] || ""
  check("04a2", "live session shows liveness: alive in chat_agents", /alive/.test(aliveEntry), aliveEntry)

  // [04a3] lease expiry: a session that just went quiet is STILL listed by the
  // server (real finished subagents persist forever) but its expired lease must
  // mark it exited. Read via instance 2, which never observed the session and
  // therefore trusts the on-disk lease.
  await I1.exec("chat_status", { status: "sleepy" }, c("sleep", "sleep"))
  const agLease = readAgents(wt)
  agLease[sess.sleep].lastSeen = Date.now() - 10 * 60 * 1000
  fs.writeFileSync(path.join(wt, ".agentchat", "agents.json"), JSON.stringify(agLease))
  const agentsOutLease = await I2.exec("chat_agents", {}, c("prim", "build"))
  check("04a3", "quiet session (lease expired but still listed by server) -> liveness: exited",
    /liveness: exited\s+doing: -/.test(agentsOutLease), agentsOutLease.slice(0, 300))

  const invDead = await I1.exec("chat_invite", { room: "pub", agents: ["zombie"] }, c("prim", "build"))
  check("04b", "chat_invite to exited session rejects with 'session has exited'",
    /zombie: session has exited/.test(invDead), invDead)

  const reclaim = await I2.exec("chat_register", { name: "zombie" }, c("rec", "rec"))
  const agAfter = readAgents(wt)
  const lounge = readRoom(wt, "lounge")
  check("04c", "reclaim dead name: succeeds; dead record purged; name purged from room members",
    /Renamed/.test(reclaim) && !agAfter[sess.vic] && agAfter[sess.rec]?.name === "zombie" &&
      !lounge.members.includes("zombie") && lounge.members.includes("prim"),
    `out=${reclaim} members=${JSON.stringify(lounge.members)}`)

  const agentsOut2 = await I1.exec("chat_agents", {}, c("prim", "build"))
  const thrEntry = agentsOut2.split("\n").find((l) => l.startsWith("- thrower")) || ""
  const thrBlock = agentsOut2.split("- thrower")[1] ?? ""
  const thrLiveness = (thrBlock.match(/liveness: ([^\n]+)/) || [])[1] || ""
  const thrDoing = (thrBlock.match(/doing: ([^\n]+)/) || [])[1] || ""
  const invThr = await I1.exec("chat_invite", { room: "dock", agents: ["thrower"] }, c("prim", "build"))
  check("04d", "client that THROWS fails open: liveness alive, 'idle', invite succeeds",
    !!thrEntry && thrLiveness === "alive" && thrDoing === "idle" && /Invited: thrower/.test(invThr),
    `entry="${thrEntry}" liveness="${thrLiveness}" doing="${thrDoing}" invite=${invThr}`)

  // [05] session.deleted pruning, shared via disk between instances
  await I1.event({ type: "session.deleted", properties: { info: { id: sess.gon } } })
  const goneName = "gone-" + sess.gon.slice(-4)
  check("05a", "session.deleted prunes record from agents.json (on disk, visible to all)",
    !readAgents(wt)[sess.gon], JSON.stringify(Object.keys(readAgents(wt))))
  const agentsI2 = await I2.exec("chat_agents", {}, c("prim", "build"))
  check("05b", "second instance sees the pruning on next load (no cached registry)",
    !agentsI2.includes(goneName), agentsI2)

  // deadCache stickiness: the same (still client-alive) session re-registers ->
  // instance-1 still treats it as dead forever, instance-2 does not
  await I1.exec("chat_status", { status: "back" }, c("gon", "gone"))
  const agentsI1 = await I1.exec("chat_agents", {}, c("prim", "build"))
  const agentsI1b = await I2.exec("chat_agents", {}, c("rec", "rec"))
  const goneLine1 = agentsI1.split("- ").find((l) => l.startsWith(goneName)) || ""
  const goneLine2 = agentsI1b.split("- ").find((l) => l.startsWith(goneName)) || ""
  const goneLiveness1 = (goneLine1.split("\n")[1] ?? "").trim()
  const goneLiveness2 = (goneLine2.split("\n")[1] ?? "").trim()
  check("05c", "session.deleted marks deadCache: instance1 keeps exited forever (alive client), instance2 sees alive",
    goneLiveness1.includes("exited") && !!goneLine2 && goneLiveness2.includes("alive"),
    `i1="${goneLine1.split("\n")[0]} ${goneLiveness1}" i2="${goneLine2.split("\n")[0]} ${goneLiveness2}"`)

  await I2.event({ type: "session.deleted", properties: { info: { id: sess.gn2 } } })
  const gone2Name = "gone2-" + sess.gn2.slice(-4)
  const agentsI1c = await I1.exec("chat_agents", {}, c("prim", "build"))
  check("05d", "event fired via instance2 also prunes for instance1 (disk-backed)",
    !readAgents(wt)[sess.gn2] && !agentsI1c.includes(gone2Name))
}

// ======================================================== section spawn:
// chat_spawn guards + deterministic AGENTCHAT_NAME/AGENTCHAT_ROOM (persistent
// workers in zellij tabs)
async function secSpawn() {
  console.log("\n--- section SPAWN ---")
  const wt = mkwt("spawn")
  const ctrl = makeClient()
  const I1 = await makeInst(wt, ctrl.client)
  const I2 = await makeInst(wt, ctrl.client) // dry-run + stale-lease mix via a "fresh" process
  const ctx = makeCtx(wt)
  const host = ctx("ses_spawn_host_001", "build")
  ctrl.alive.add("ses_spawn_host_001")
  await I1.exec("chat_register", { name: "host" }, host)
  await I1.exec("chat_room_create", { name: "ops", purpose: "ops room" }, host)

  const prev = { NAME: process.env.AGENTCHAT_NAME, ROOM: process.env.AGENTCHAT_ROOM, Z: process.env.ZELLIJ }
  if (process.env.ZELLIJ !== undefined) delete process.env.ZELLIJ
  const noZ = await I1.exec("chat_spawn", { name: "worker1", room: "ops" }, host)
  check("SP1", "chat_spawn outside zellij is refused",
    /requires zellij/.test(noZ), noZ)
  try {
    if (process.env.AGENTCHAT_NAME !== undefined) delete process.env.AGENTCHAT_NAME
    if (process.env.AGENTCHAT_ROOM !== undefined) delete process.env.AGENTCHAT_ROOM
    process.env.AGENTCHAT_NAME = "worker1"
    process.env.AGENTCHAT_ROOM = "ops"
    const w = "ses_spawn_w1_0002"
    ctrl.alive.add(w)
    const out1 = await I1.exec("chat_status", { status: "on duty" }, ctx(w, "worker"))
    const rec = readAgents(wt)[w]
    check("SP2a", "AGENTCHAT_NAME env gives the spawned worker a deterministic chat name",
      /Status updated/.test(out1) && rec?.name === "worker1", `rec=${JSON.stringify(rec)} out=${out1}`)
    const hq = readRoom(wt, "ops")
    check("SP2b", "AGENTCHAT_ROOM env auto-joins the spawned worker",
      hq.members.includes("worker1"), `members=${JSON.stringify(hq.members)}`)
  } finally {
    if (prev.NAME === undefined) delete process.env.AGENTCHAT_NAME
    else process.env.AGENTCHAT_NAME = prev.NAME
    if (prev.ROOM === undefined) delete process.env.AGENTCHAT_ROOM
    else process.env.AGENTCHAT_ROOM = prev.ROOM
  }

  process.env.ZELLIJ = "1"
  try {
    // stale holder: register + join, then backdate the lease on disk.
    const stale = "ses_spawn_stale_003"
    ctrl.alive.add(stale)
    await I1.exec("chat_status", { status: "ghost" }, ctx(stale, "ghost"))
    await I1.exec("chat_room_join", { room: "ops" }, ctx(stale, "ghost"))
    const ghostName = readAgents(wt)[stale].name
    const ag = readAgents(wt)
    ag[stale].lastSeen = Date.now() - 10 * 60 * 1000
    fs.writeFileSync(path.join(wt, ".agentchat", "agents.json"), JSON.stringify(ag))

    // I2 has never observed `stale`, so it sees the expired lease: purge + dry-run.
    const dry = await I2.exec("chat_spawn", { name: ghostName, room: "ops" }, host)
    check("SP3a", "spawn over a stale holder purges the dead record and its room membership",
      !readAgents(wt)[stale] && !readRoom(wt, "ops").members.includes(ghostName) &&
        /\[dry-run/.test(dry),
      dry.slice(0, 200))
    check("SP3b", "dry-run (no inline runner) exposes the exact zellij+env command",
      new RegExp(`zellij action new-tab --name '${ghostName}' -- zsh -lc`).test(dry) && /AGENTCHAT_NAME=/.test(dry) &&
        /AGENTCHAT_ROOM=.*ops/.test(dry) &&
        /export AGENTCHAT_NAME=/.test(dry) && /exec opencode \. --prompt/.test(dry),
      dry.slice(0, 300))

    const took = await I2.exec("chat_spawn", { name: "worker1" }, host)
    check("SP3c", "spawn refuses a name held by a live agent",
      /held by a live agent/.test(took), took)
  } finally {
    if (prev.Z === undefined) delete process.env.ZELLIJ
    else process.env.ZELLIJ = prev.Z
  }
}

// ====================================================== section register race:
// concurrent reclaim of a dead-held name from 2 instances (req. 3)
async function secRegRace() {
  console.log("\n--- section REG-RACE ---")
  const wt = mkwt("regrace")
  const ctrl = makeClient(8) // liveness await yields real event-loop slices
  const I1 = await makeInst(wt, ctrl.client)
  const I2 = await makeInst(wt, ctrl.client)
  const ctx = makeCtx(wt)
  const d = "ses_rr_dead__0001"
  const a = "ses_rr_alice_002"
  const b = "ses_rr_bob__003"
  ctrl.alive.add(d).add(a).add(b)
  await I1.exec("chat_register", { name: "hero" }, ctx(d, "dead"))
  await I1.exec("chat_room_create", { name: "club", purpose: "hero club" }, ctx(d, "dead"))
  await I2.exec("chat_status", { status: "wanna be hero" }, ctx(a, "aa"))
  await I1.exec("chat_status", { status: "wanna be hero" }, ctx(b, "bb"))
  ctrl.alive.delete(d) // holder dies

  const [ra, rb] = await Promise.all([
    I1.exec("chat_register", { name: "hero" }, ctx(a, "aa")),
    I2.exec("chat_register", { name: "hero" }, ctx(b, "bb")),
  ])
  const ag = readAgents(wt)
  const heroes = Object.values(ag as Record<string, any>).filter((r: any) => r.name === "hero")
  const bothRenamed = /Renamed/.test(ra) && /Renamed/.test(rb)
  const dupNames = heroes.length === 2
  const club = readRoom(wt, "club")
  const dupMembers = club.members.filter((m: string) => m === "hero").length
  // regression for the fixed double-claim race: post-liveness-check the
  // plugin must re-load agents.json and re-check the name before writing.
  check(
    "03",
    "concurrent reclaim of dead-held name: exactly one claimant wins (I5 holds)",
    !dupNames && bothRenamed === false && heroes.length === 1 && dupMembers <= 1 &&
      (/Renamed/.test(ra) || /Renamed/.test(rb)) &&
      (/claimed by another/.test(ra) || /claimed by another/.test(rb)),
    `dupNames=${dupNames} heroes=${heroes.length} dupMembers=${dupMembers} ra="${ra}" rb="${rb}"`,
  )
}

// ========================================================= section corrupt:
// garbage state quarantines and recovers (req. 6)
async function secCorrupt() {
  console.log("\n--- section CORRUPT ---")
  const wt = mkwt("corrupt")
  const ctrl = makeClient()
  const I = await makeInst(wt, ctrl.client)
  const ctx = makeCtx(wt)
  const K = ctx("ses_cor_kep__0001", "keeper")
  ctrl.alive.add("ses_cor_kep__0001")
  await I.exec("chat_register", { name: "keeper" }, K)
  await I.exec("chat_room_create", { name: "solid", purpose: "doomed room" }, K)
  await I.exec("chat_room_create", { name: "good", purpose: "survivor room" }, K)

  // clobber agents.json and one room file with garbage
  fs.writeFileSync(path.join(wt, ".agentchat", "agents.json"), "{{{{not json at all")
  fs.writeFileSync(path.join(wt, ".agentchat", "rooms", "solid.json"), "\u0000\u0001 binary junk \u00ff")

  let listOut = ""
  let threw = false
  try {
    listOut = await I.exec("chat_room_list", {}, K) // first tool call triggers quarantine
  } catch {
    threw = true
  }
  check("06a", "garbage in agents.json + rooms/*.json: next tool call does not throw", !threw, listOut)
  check("06b", "quarantine: both files renamed to *.corrupt-* and excluded from listing",
    listOut.includes("good") && !listOut.includes("solid") &&
      fs.readdirSync(path.join(wt, ".agentchat")).some((f) => f.startsWith("agents.json.corrupt-")) &&
      fs.readdirSync(path.join(wt, ".agentchat", "rooms")).some((f) => f.startsWith("solid.json.corrupt-")) &&
      !fs.existsSync(path.join(wt, ".agentchat", "rooms", "solid.json")),
    listOut)
  const agentsOut = await I.exec("chat_agents", {}, K)
  check("06c", "recovers as empty registry: caller re-registers cleanly, no crash",
    /only agent registered/i.test(agentsOut) || /keeper-p__0001|keeper/.test(agentsOut), agentsOut)
  const corruptN =
    fs.readdirSync(path.join(wt, ".agentchat")).filter((f) => f.includes(".corrupt-")).length +
    fs.readdirSync(path.join(wt, ".agentchat", "rooms")).filter((f) => f.includes(".corrupt-")).length
  const list2 = await I.exec("chat_room_list", {}, K)
  check("06d", "subsequent calls stable: no repeated quarantine, good room still listed",
    corruptN === 2 && list2.includes("good"), `corruptFiles=${corruptN}`)
}

// ========================================================== section legacy:
// pre-`first` room schema + out-of-range cursors must load (req. 7)
async function secLegacy() {
  console.log("\n--- section LEGACY ---")
  const wt = mkwt("legacy")
  const root = path.join(wt, ".agentchat")
  fs.mkdirSync(path.join(root, "rooms"), { recursive: true })
  const rec = (id: string, name: string, reads: Record<string, number>) => ({
    sessionID: id, name, agent: "build", status: "", statusAt: 0, registeredAt: 1, reads,
  })
  fs.writeFileSync(
    path.join(root, "agents.json"),
    JSON.stringify({
      "ses_leg_a__0001": rec("ses_leg_a__0001", "old-a", { legacy: 1 }),
      "ses_leg_b__0001": rec("ses_leg_b__0001", "old-b", { legacy: 999 }), // cursor far ahead of total
      "ses_leg_c__0001": rec("ses_leg_c__0001", "old-c", {}),
    }),
  )
  // legacy room: NO `first`, messages without `i`
  fs.writeFileSync(
    path.join(root, "rooms", "legacy.json"),
    JSON.stringify({
      id: "legacy", name: "legacy", purpose: "pre-first schema", createdBy: "old-a", createdAt: 1,
      members: ["old-a", "old-b"], invites: [],
      messages: [
        { ts: 1, from: "old-a", text: "m0" },
        { ts: 2, from: "old-a", text: "m1" },
        { ts: 3, from: "old-a", text: "m2" },
      ],
    }),
  )
  // even thinner room: no invites, no messages, no first
  fs.writeFileSync(
    path.join(root, "rooms", "thin.json"),
    JSON.stringify({ id: "thin", name: "thin", purpose: "sparse", createdBy: "old-a", createdAt: 2, members: ["old-a"] }),
  )
  const ctrl = makeClient()
  for (const id of ["ses_leg_a__0001", "ses_leg_b__0001", "ses_leg_c__0001"]) ctrl.alive.add(id)
  const I = await makeInst(wt, ctrl.client)
  const ctx = makeCtx(wt)
  const A = ctx("ses_leg_a__0001", "build")
  const B = ctx("ses_leg_b__0001", "build")
  const C = ctx("ses_leg_c__0001", "build")

  let out = ""
  let threw = false
  try {
    out = await I.exec("chat_room_list", {}, A)
  } catch {
    threw = true
  }
  check("07a", "legacy room (no `first`, messages without `i`) loads; backfilled cursor sane",
    !threw && /\[member, 2 unread\]/.test(out) && !out.includes("NaN") && !out.includes("-1 unread"), out)

  const r1 = await I.exec("chat_read", { room: "legacy" }, A)
  const r2 = await I.exec("chat_read", { room: "legacy" }, A)
  check("07b", "legacy cursor=1 -> sees exactly m1,m2; re-read says no new",
    /2 message\(s\)/.test(r1) && /m1/.test(r1) && /m2/.test(r1) && !/m0/.test(r1) && /no new/.test(r2), r1)

  const rb = await I.exec("chat_read", { room: "legacy" }, B)
  const lb = await I.exec("chat_room_list", {}, B)
  check("07c", "cursor (999) ahead of total clamps: 0 unread, no negative, no crash",
    /no new messages\. \(3 total, 3 retained\)/.test(rb) && !/\d+ unread/.test(lb) && !/NaN|-\d+ unread/.test(lb),
    `[${rb}] [${lb}]`)

  const rc = await I.exec("chat_room_join", { room: "legacy" }, C)
  check("07d", "join of legacy room works (invites backfilled); fresh cursor sees all 3",
    /Joined/.test(rc) && /3 message\(s\)/.test(rc), rc)

  const rt = await I.exec("chat_read", { room: "thin" }, A)
  const legacyAfter = JSON.parse(fs.readFileSync(path.join(root, "rooms", "legacy.json"), "utf8"))
  check("07e", "room missing invites/messages behaves empty; rewritten file gains first=0",
    /no new messages\. \(0 total, 0 retained\)/.test(rt) && legacyAfter.first === 0,
    `[${rt}] first=${legacyAfter.first}`)
}

// ============================================================== section trim:
// cap at exactly MAX_MESSAGES + off-by-one at trim/cursor boundary (req. 8)
async function secTrim() {
  console.log("\n--- section TRIM (heavy: ~2000 posts) ---")
  const wt = mkwt("trim")
  const ctrl = makeClient()
  const I = await makeInst(wt, ctrl.client)
  const ctx = makeCtx(wt)
  const A = ctx("ses_trim_capa_001", "capa")
  const C = ctx("ses_trim_capc_002", "capc")
  const B = ctx("ses_trim_capb_003", "capb")
  for (const s of [A, B, C]) ctrl.alive.add(s.sessionID)
  await I.exec("chat_register", { name: "capA" }, A)
  await I.exec("chat_register", { name: "capC" }, C)
  await I.exec("chat_register", { name: "capB" }, B)

  await I.exec("chat_room_create", { name: "trimzone", purpose: "trim edge testing" }, A)
  await I.exec("chat_room_join", { room: "trimzone" }, C)
  const post = async (from: ToolContext, i: number) => {
    await I.exec("chat_post", { room: "trimzone", message: msg(i) }, from)
  }
  for (let i = 1; i <= 999; i++) await post(A, i) // creation + 999 = exactly 1000 retained
  let room = readRoom(wt, "trimzone")
  check("08a", "room sits at exactly MAX_MESSAGES=1000 retained, first=0, no early trim",
    room.messages.length === 1000 && room.first === 0 && room.messages[0].i === 0,
    `len=${room.messages.length} first=${room.first}`)

  const rmid = await I.exec("chat_read", { room: "trimzone" }, C) // capC cursor -> 1000 (== total pre-invite)
  const invOut = await I.exec("chat_invite", { room: "trimzone", agents: ["capB"] }, A) // notice = msg #1001
  room = readRoom(wt, "trimzone")
  check("08b", "invite notice pushed at exact cap: length trimmed back to 1000, first=1",
    /Invited: capB/.test(invOut) && /999 message\(s\)/.test(rmid) && room.messages.length === 1000 &&
      room.first === 1 && room.messages[0].i === 1 && room.messages[room.messages.length - 1].i === 1000,
    `len=${room.messages.length} first=${room.first}`)

  const listC = await I.exec("chat_room_list", {}, C)
  check("08c", "member with cursor==total-before-invite sees EXACTLY 1 unread after invite notice",
    /\[member, 1 unread\]/.test(listC), listC.split("\n")[0])

  for (let i = 1000; i <= 1998; i++) await post(A, i) // 999 more: total=2000, first=1000 == capC cursor
  room = readRoom(wt, "trimzone")
  const listC2 = await I.exec("chat_room_list", {}, C)
  check("08d", "trim boundary cursor==first (1000==1000): unread exactly 1000 (all retained)",
    room.first === 1000 && room.messages[0].i === 1000 && /\[member, 1000 unread\]/.test(listC2),
    `first=${room.first} list=${listC2.split("\n")[0]}`)

  await post(A, 1999) // total=2001, first=1001 — now PAST capC's cursor
  room = readRoom(wt, "trimzone")
  const listC3 = await I.exec("chat_room_list", {}, C)
  check("08e", "trim passes cursor (first=1001 > cursor=1000): unread still exactly 1000, no negative",
    room.first === 1001 && /\[member, 1000 unread\]/.test(listC3) && !/NaN|-\d+ unread/.test(listC3),
    `first=${room.first} list=${listC3.split("\n")[0]}`)

  const readC = await I.exec("chat_read", { room: "trimzone" }, C)
  const listC4 = await I.exec("chat_room_list", {}, C)
  const readC2 = await I.exec("chat_read", { room: "trimzone" }, C)
  check("08f", "read after trim-past-cursor returns exactly 1000 lines, marks read cleanly",
    /#trimzone — 1000 message\(s\)/.test(readC) && /\[member\]/.test(listC4) &&
      /no new messages\. \(2001 total, 1000 retained\)/.test(readC2),
    `${readC.split("\n")[0]} / ${listC4.split("\n")[0]} / ${readC2}`)
}

// ============================================================ section refs:
// room ref resolution, precedence, path traversal, punctuation (req. 9)
async function secRefs() {
  console.log("\n--- section REFS ---")
  const wt = mkwt("refs")
  const ctrl = makeClient()
  const I = await makeInst(wt, ctrl.client)
  const ctx = makeCtx(wt)
  const R = ctx("ses_ref_a___0001", "refa")
  const Rb = ctx("ses_ref_b___0002", "refb")
  const P = ctx("ses_ref_pwn_0003", "pwn")
  for (const s of [R, Rb, P]) ctrl.alive.add(s.sessionID)
  await I.exec("chat_register", { name: "refa" }, R)
  await I.exec("chat_register", { name: "refb" }, Rb)

  // [09a] exact-ID match must win over another room's exact-NAME match
  await I.exec("chat_room_create", { name: "Zeta", purpose: "the real zeta" }, R)
  writeRoom(wt, "aaa", {
    id: "x1", name: "zeta", purpose: "hand-written name squatter", createdBy: "refa", createdAt: 0,
    first: 0, members: ["refa", "refb"], invites: [],
    messages: [{ i: 0, ts: 1, from: "refa", text: "hand" }],
  })
  const pz = await I.exec("chat_post", { room: "zeta", message: "to-zeta" }, R)
  const x1 = readRoom(wt, "aaa")
  check("09a", "room ref resolution: exact ID beats another room's exact NAME",
    /Posted to #zeta/.test(pz) && x1.messages.length === 1 && !JSON.stringify(x1).includes("to-zeta"), pz)

  // [09b] case-insensitive name fallback
  await I.exec("chat_room_create", { name: "Case House", purpose: "case test" }, R)
  const jCH = await I.exec("chat_room_join", { room: "CASE HOUSE" }, Rb)
  const pCH = await I.exec("chat_post", { room: "cAsE hOuSe", message: "hi" }, Rb)
  check("09b", "case-insensitive name ref resolves (join + post)",
    /Joined "Case House"/.test(jCH) && /Posted to #case-house/.test(pCH), `[${jCH}] [${pCH}]`)

  // [09c] traversal attempts via room names (slugged) and refs (rejected)
  const before = walk(wt)
  const e1 = await I.exec("chat_room_create", { name: "../escape", purpose: "trav1" }, R)
  const e2 = await I.exec("chat_room_create", { name: "%2e%2e%2fevil", purpose: "trav2" }, R)
  const e3 = await I.exec("chat_room_create", { name: "....//....//etc/passwd", purpose: "trav3" }, R)
  const e4 = await I.exec("chat_room_create", { name: "..%2f..", purpose: "trav4" }, R)
  check("09c", "traversal-bearing names slug into safe in-room ids (no ../ in ids)",
    /id: escape/.test(e1) && /id: 2e-2e-2fevil/.test(e2) && /id: etc-passwd/.test(e3) && /id: 2f/.test(e4),
    `[${e1}] [${e2}] [${e3}] [${e4}]`)
  const badRefs = ["../../etc/passwd", "..", "/etc/passwd", "%2e%2e%2f..%2f..%2fetc%2fpasswd", "../../../etc/passwd", "../x"]
  const refOuts = await Promise.all([
    ...badRefs.map((r) => I.exec("chat_room_join", { room: r }, R)),
    ...badRefs.map((r) => I.exec("chat_post", { room: r, message: "x" }, R)),
  ])
  check("09c2", "traversal refs rejected with 'No room' error for join AND post",
    refOuts.every((o) => /No room/.test(o)), refOuts.slice(0, 2).join(" | "))
  const after = walk(wt)
  const added = after.filter((p) => !before.includes(p))
  const allInside = added.every((p) => p.startsWith(".agentchat") && !p.includes(".."))
  check("09c3", "no files created outside .agentchat/ by traversal names/refs (fs listing diff)",
    allInside &&
      !fs.existsSync(path.join(wt, "evil.json")) &&
      !fs.existsSync(path.join(wt, ".agentchat", "evil.json")) &&
      !fs.existsSync(path.join(wt, "etc", "passwd")) &&
      !fs.existsSync(path.join(os.tmpdir(), "evil.json")) &&
      !fs.existsSync(path.join(os.tmpdir(), "etc-passwd.json")),
    `added=${JSON.stringify(added)}`)

  // [09d] punctuation-only names collapse to id "room"; second distinct punctuation name collides
  const p1 = await I.exec("chat_room_create", { name: "!!!", purpose: "bangs" }, R)
  const p2 = await I.exec("chat_room_create", { name: "@@@", purpose: "ats" }, R)
  const jBang = await I.exec("chat_room_join", { room: "!!!" }, Rb)
  check("09d", "punctuation-only name -> id 'room'; other punctuation-only name gets id-taken; join by name works",
    /id: room/.test(p1) && /is taken/.test(p2) && /Joined "!!!"/.test(jBang), `[${p1}] [${p2}] [${jBang}]`)

  // [09e] KNOWN WEAKNESS: room ids read back from hand-written files are used unvalidated
  const parentBefore = fs.readdirSync(path.dirname(wt))
  writeRoom(wt, "pwnfile", {
    id: "../../evil-pwn", name: "pwnroom", purpose: "crafted id", createdBy: "h", createdAt: 0,
    first: 0, members: ["pwn-0003"], invites: [], messages: [{ i: 0, ts: 1, from: "h", text: "x" }],
  })
  await I.exec("chat_status", { status: "sneaky" }, P) // auto-name pwn-0003
  await I.exec("chat_register", { name: "pwn2" }, P) // rename sweeps members -> writes room by crafted id
  const escaped = fs.existsSync(path.join(wt, "evil-pwn.json"))
  const parentNew = fs.readdirSync(path.dirname(wt)).filter((f) => !parentBefore.includes(f))
  const lst = await I.exec("chat_room_list", {}, R)
  // regression for the fixed id-escape bug: room ids read from disk must be
  // validated against the filename and never reach roomFile() for writes.
  check(
    "09e",
    "crafted room-file id never used for writes; hand-edited file skipped from listings",
    !escaped && !/pwnroom/.test(lst) && !parentNew.some((f) => f.includes("evil")),
    `escaped=${escaped} parentNew=${JSON.stringify(parentNew)} list="${lst.slice(0, 120)}"`,
  )
}

// ====================================================== section activity cap:
// MAX_ACTIVITY bound inferred indirectly via chat_agents (req. 11)
async function secActivity() {
  console.log("\n--- section ACTIVITY (250 sessions) ---")
  const wt = mkwt("activity")
  const ctrl = makeClient()
  const I = await makeInst(wt, ctrl.client)
  const ctx = makeCtx(wt)
  const watcher = ctx("ses_act_watch_001", "watch")
  ctrl.alive.add("ses_act_watch_001")
  await I.exec("chat_status", { status: "watching" }, watcher)
  const N = 250 // > MAX_ACTIVITY (200)
  for (let i = 0; i < N; i++) {
    const id = `ses_act_${String(i).padStart(4, "0")}`
    ctrl.alive.add(id)
    await I.before({ tool: "dummy-t", sessionID: id })
    await I.exec("chat_register", {}, ctx(id, "act"))
  }
  let out = ""
  let threw = false
  try {
    out = await I.exec("chat_agents", {}, watcher)
  } catch {
    threw = true
  }
  const activeN = count(out, /doing: active \(last tool: dummy-t/g)
  const neverN = count(out, /last seen: never/g)
  const idleN = count(out, /doing: idle/g)
  check("11", "activity map bounded at MAX_ACTIVITY=200: 200 sessions show activity, 50 evicted fall back to idle with lease-backed 'last seen' (no 'never') without crash",
    !threw && activeN === 200 && idleN === 50 && neverN === 0,
    `threw=${threw} active=${activeN} never=${neverN} idle=${idleN}`)
}

// ==================================================================== main

async function main() {
  await secRace()
  await secLimits()
  await secLiveness()
  await secSpawn()
  await secRegRace()
  await secCorrupt()
  await secLegacy()
  await secTrim()
  await secRefs()
  await secActivity()

  const pass = results.filter((r) => r.status === "PASS").length
  const xf = results.filter((r) => r.status === "XFAIL").length
  console.log(
    `\n${"=".repeat(60)}\nSTRESS SUMMARY: ${pass} PASS, ${failures} FAIL, ${xf} XFAIL ` +
      `(${results.length} checks)\n${"=".repeat(60)}`,
  )
  if (xf) console.log("XFAILs are documented plugin bugs — see test/FINDINGS-STRESS.md")
  process.exit(failures ? 1 : 0)
}

main().catch((e) => {
  console.error("SUITE CRASHED:", e)
  process.exit(1)
})
