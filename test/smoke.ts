import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { ToolContext } from "@opencode-ai/plugin"
import AgentChat from "../index.ts"

const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "agentchat-"))

let assertFailures = 0
const origAssert = console.assert.bind(console)
console.assert = ((cond?: unknown, ...args: unknown[]) => {
  if (!cond) {
    assertFailures++
    origAssert(false, args.map(String).join(" "))
  }
}) as typeof console.assert

const alive = new Set(["ses_build_primary01", "ses_be_task_aaa1", "ses_fe_task_bbb2"])

async function main() {
  const fakeClient = {
    session: {
      get: async ({ path: { id } }: { path: { id: string } }) =>
        alive.has(id) ? { data: { id }, error: undefined } : { data: undefined, error: { status: 404 } },
    },
  }
  const hooks = await AgentChat({
    worktree,
    client: fakeClient,
  } as never)

  const t = hooks.tool as Record<string, { execute: (a: never, c: ToolContext) => Promise<string> }>

  const ctx = (sessionID: string, agent: string): ToolContext =>
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

  const build = ctx("ses_build_primary01", "build")
  const be = ctx("ses_be_task_aaa1", "be")
  const fe = ctx("ses_fe_task_bbb2", "fe")

  const run = async (label: string, name: string, args: unknown, c: ToolContext) => {
    const out = await t[name].execute(args as never, c)
    console.log(`\n=== ${label} (${name}) ===\n${String(out)}`)
  }

  await run("auto-identity", "chat_register", {}, build)
  await run("rename build", "chat_register", { name: "captain" }, build)
  await run("rename be", "chat_register", { name: "backend-dev" }, be)
  await run("rename fe", "chat_register", { name: "frontend-dev" }, fe)
  await run("dup name rejected", "chat_register", { name: "backend-dev" }, fe)
  await run("status build", "chat_status", { status: "coordinating refactor" }, build)
  await run("status be", "chat_status", { status: "implementing API" }, be)
  await run("directory", "chat_agents", {}, build)
  await run("create room", "chat_room_create", { name: "refactor", purpose: "coordinate the module refactor" }, build)
  await run("dup create", "chat_room_create", { name: "refactor", purpose: "coordinate the module refactor" }, fe)
  await run("post", "chat_post", { room: "refactor", message: "kicking off; API changes go here" }, build)
  await run("post non-member fails", "chat_post", { room: "refactor", message: "hi" }, fe)
  await run("invite", "chat_invite", { room: "refactor", agents: ["backend-dev", "frontend-dev", "ghost"] }, build)
  await run("list (fe sees invite)", "chat_room_list", {}, fe)
  await run("join accepts invite", "chat_room_join", { room: "refactor" }, fe)
  await run("post fe", "chat_post", { room: "refactor", message: "joined, UI side is mine" }, fe)
  await run("read fe (no new)", "chat_read", { room: "refactor" }, fe)
  await run("post build", "chat_post", { room: "refactor", message: "thanks, review by EOD" }, build)
  await run("read fe (new only)", "chat_read", { room: "refactor" }, fe)
  await run("read fe (history)", "chat_read", { room: "refactor", include_read: true }, fe)
  await run("read by room name", "chat_read", { room: "Refactor" }, be)

  // rename carries membership over
  await run("rename fe", "chat_register", { name: "ui-dev" }, fe)
  const room = JSON.parse(fs.readFileSync(path.join(worktree, ".agentchat", "rooms", "refactor.json"), "utf8"))
  console.assert(room.members.includes("ui-dev"), "membership not carried over on rename")

  // final directory (all three alive)
  await run("final directory", "chat_agents", {}, be)

  // dead-session handling: fe exits
  alive.delete("ses_fe_task_bbb2")
  await run("create room for dead tests", "chat_room_create", { name: "archive", purpose: "wrap-up notes" }, build)
  await run("invite dead fails", "chat_invite", { room: "archive", agents: ["ui-dev"] }, build)
  await run("dead agent listed as exited", "chat_agents", {}, build)
  await run("reclaim dead name", "chat_register", { name: "ui-dev" }, be)
  const afterReclaim = JSON.parse(fs.readFileSync(path.join(worktree, ".agentchat", "rooms", "refactor.json"), "utf8"))
  console.assert(!afterReclaim.members.includes("ui-dev"), "dead name not purged from members on reclaim")
  await run("rename be back", "chat_register", { name: "backend-dev" }, be)
  const afterBack = JSON.parse(fs.readFileSync(path.join(worktree, ".agentchat", "rooms", "refactor.json"), "utf8"))
  // be reclaimed a purged name, so it holds NO inherited membership from the
  // dead agent; the later rename must not resurrect one either.
  console.assert(
    !afterBack.members.includes("backend-dev") && !afterBack.members.includes("ui-dev"),
    "purged dead membership should not reappear on rename",
  )

  // trimming: exceed MAX_MESSAGES and confirm stale cursors still see new posts
  await run("create trim room", "chat_room_create", { name: "trim", purpose: "test trimming" }, build)
  for (let i = 1; i <= 1002; i++) await t["chat_post"].execute({ room: "trim", message: `m${i}` } as never, build)
  const trimRoom = JSON.parse(fs.readFileSync(path.join(worktree, ".agentchat", "rooms", "trim.json"), "utf8"))
  console.assert(trimRoom.messages.length === 1000, `expected 1000 retained, got ${trimRoom.messages.length}`)
  console.assert(trimRoom.first === 3, `expected first=3, got ${trimRoom.first}`)
  console.assert(trimRoom.messages[0].i === 3, `expected first msg i=3, got ${trimRoom.messages[0].i}`)
  await run("be joins trim", "chat_room_join", { room: "trim" }, be)
  await run("be posts after trim", "chat_post", { room: "trim", message: "post-trim-be" }, be)
  await run("captain sees post-trim (cursor survived trim)", "chat_read", { room: "trim" }, build)
  await run("captain unread count sane", "chat_room_list", {}, build)

  if (assertFailures) {
    console.error(`\nSMOKE FAILED: ${assertFailures} assertion failure(s)`)
    process.exit(1)
  }
  console.log("\nOK — state in", path.join(worktree, ".agentchat"))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
