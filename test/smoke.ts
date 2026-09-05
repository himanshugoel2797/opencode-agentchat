import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { ToolContext } from "@opencode-ai/plugin"
import AgentChat from "../index.ts"

const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "agentchat-"))

async function main() {
  const hooks = await AgentChat({
    worktree,
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
  await run("final directory", "chat_agents", {}, be)

  // rename carries membership over
  await run("rename fe", "chat_register", { name: "ui-dev" }, fe)
  const room = JSON.parse(fs.readFileSync(path.join(worktree, ".agentchat", "rooms", "refactor.json"), "utf8"))
  console.assert(room.members.includes("ui-dev"), "membership not carried over on rename")
  console.log("\nOK — state in", path.join(worktree, ".agentchat"))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
