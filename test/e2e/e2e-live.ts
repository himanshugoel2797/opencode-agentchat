/**
 * e2e-live.ts — live end-to-end harness for the opencode-agentchat plugin.
 *
 * Single process, fully non-interactive:
 *   1. Mock LLM: local OpenAI-compatible server (POST /v1/chat/completions).
 *      Each prompt embeds an explicit tool-call script (E2E-SCRIPT-JSON);
 *      the mock replays it one tool_call per request by counting tool-role
 *      messages after the last user message, then emits a final text turn.
 *   2. Isolated env: temp XDG dirs (config/data/state/cache), global config
 *      with provider "mock" (@ai-sdk/openai-compatible -> the mock server),
 *      package.json + npm install, temp project dir whose
 *      .opencode/plugins/agentchat symlinks to the plugin repo.
 *   3. `opencode serve` against it; scenario driven over plain HTTP
 *      (POST /session, POST /session/{id}/prompt_async), turn completion
 *      detected via session.idle on the GET /event SSE stream.
 *   4. Asserts .agentchat state files, tool outputs captured from SSE, and
 *      clean text endings; prints artifact dir; nonzero exit on any failure.
 *
 * Run: npx tsx test/e2e/e2e-live.ts        (exit 0 = pass)
 * Env: E2E_DEBUG=1 dump every SSE event; E2E_KEEP=1 leave processes' logs.
 */
import * as fs from "node:fs"
import * as net from "node:net"
import * as os from "node:os"
import * as http from "node:http"
import * as path from "node:path"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"

const REPO = path.resolve(import.meta.dirname, "..", "..")
const OPENCODE_BIN = path.join(os.homedir(), ".opencode", "bin", "opencode")
const HARD_TIMEOUT_MS = 300_000
const TURN_TIMEOUT_MS = 45_000

// ------------------------------------------------------------------ logging
const T0 = Date.now()
const log = (...a: unknown[]) =>
  console.log(`[e2e +${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a)
const DEBUG = !!process.env.E2E_DEBUG

// ------------------------------------------------------------------ asserts
const failures: string[] = []
let checkCount = 0
function check(cond: unknown, msg: string, detail?: unknown) {
  checkCount++
  if (cond) log(`  PASS  ${msg}`)
  else {
    failures.push(msg)
    console.error(`  FAIL  ${msg}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ""}`)
  }
}
function fail(msg: string): never {
  failures.push(msg)
  throw new Error(msg)
}

// ------------------------------------------------------------------ temp env
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-e2e-"))
const XDG_CONFIG = path.join(tmp, "xdg-config")
const XDG_DATA = path.join(tmp, "xdg-data")
const XDG_STATE = path.join(tmp, "xdg-state")
// Cache is shared ACROSS runs (keyed path outside the mkdtemp): opencode
// installs plugin deps via bun/npm on first plugin load; with a cold cache
// every run that hits the registry takes 10s-160s+ (flaky readiness).
// Still isolated from the user's real caches. Delete this dir to force cold.
const XDG_CACHE = path.join(os.tmpdir(), "opencode-agentchat-e2e-cache")
fs.mkdirSync(XDG_CACHE, { recursive: true })
const CFG_DIR = path.join(XDG_CONFIG, "opencode")
const PROJ = path.join(tmp, "proj")
const SERVE_LOG = path.join(tmp, "serve.log")
const MOCK_LOG = path.join(tmp, "mock-requests.log")
const EVENTS_LOG = path.join(tmp, "events.log")
for (const d of [CFG_DIR, XDG_DATA, XDG_STATE, XDG_CACHE, path.join(PROJ, ".opencode", "plugins")])
  fs.mkdirSync(d, { recursive: true })
const serveLogChunks: string[] = []
const eventsLogChunks: string[] = []
const systemIssues: string[] = []
function appendFile(file: string, s: string) {
  try {
    fs.appendFileSync(file, s)
  } catch {}
}

// ------------------------------------------------------------------ mock LLM
type ScriptStep = [string, Record<string, unknown>]
const mockLog: any[] = []
let callSeq = 0

function textContent(msg: any): string {
  const c = msg?.content
  if (typeof c === "string") return c
  if (Array.isArray(c)) return c.map((p: any) => (p?.type === "text" ? p.text ?? "" : "")).join("\n")
  return ""
}

/** Decide the next assistant action from the conversation state. */
function decide(body: any): { kind: "tool"; tool: string; args: any; callId: string } | { kind: "text"; text: string } {
  const msgs: any[] = Array.isArray(body?.messages) ? body.messages : []
  let lastUser = -1
  for (let i = msgs.length - 1; i >= 0; i--)
    if (msgs[i]?.role === "user") {
      lastUser = i
      break
    }
  const m = textContent(msgs[lastUser]).match(/E2E-SCRIPT-JSON: (\[[\s\S]*\])/)
  if (!m) return { kind: "text", text: "ack" } // title-gen or any non-script call
  let script: ScriptStep[]
  try {
    script = JSON.parse(m[1])
  } catch (e: any) {
    return { kind: "text", text: `E2E-SCRIPT-BAD-JSON: ${e.message}` }
  }
  let done = 0
  for (let i = lastUser + 1; i < msgs.length; i++) if (msgs[i]?.role === "tool") done++
  if (done < script.length) {
    const [tool, args] = script[done]
    return { kind: "tool", tool, args, callId: `call_e2e_${++callSeq}` }
  }
  return { kind: "text", text: `E2E-DONE completed ${script.length} tool step(s).` }
}

function openaiChunk(model: string, delta: any, finish: string | null) {
  return {
    id: `chatcmpl-e2e-${callSeq}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: delta ?? {}, ...(finish ? { finish_reason: finish } : { finish_reason: null }) }],
  }
}

const mockServer = http.createServer((req, res) => {
  const url = req.url ?? ""
  if (req.method === "GET" && url === "/healthz") {
    res.writeHead(200).end("ok")
    return
  }
  if (req.method === "GET" && url.startsWith("/v1/models")) {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ object: "list", data: [] }))
    return
  }
  if (req.method !== "POST" || !url.includes("/chat/completions")) {
    res.writeHead(404).end("not found")
    return
  }
  const chunks: Buffer[] = []
  req.on("data", (d) => chunks.push(d))
  req.on("end", () => {
    let body: any
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    } catch (e: any) {
      appendFile(MOCK_LOG, `#${callSeq} UNPARSEABLE ${Buffer.concat(chunks).toString("utf8").slice(0, 2000)}\n`)
      res.writeHead(400).end("bad json")
      return
    }
    const decision = decide(body)
    const sysMsgs: any[] = body.messages ?? []
    let seenNonSystem = false
    for (const mm of sysMsgs) {
      if (mm?.role === "system") {
        if (seenNonSystem) systemIssues.push(`req #${mockLog.length + 1}: system role seen after non-system (${sysMsgs.map((x: any) => x.role).join(",")})`)
      } else seenNonSystem = true
    }
    const entry = {
      n: mockLog.length + 1,
      stream: !!body.stream,
      model: body.model,
      roles: (body.messages ?? []).map((x: any) => x.role).join(","),
      tools: (body.tools ?? []).map((t: any) => t.function?.name ?? t.name).filter(Boolean),
      decision: decision.kind === "tool" ? `tool:${decision.tool} ${JSON.stringify(decision.args)}` : `text:${decision.text}`,
    }
    mockLog.push(entry)
    const line = JSON.stringify(entry) + "\n"
    appendFile(MOCK_LOG, `#${entry.n} ${line}`)
    log(`  mock req ${entry.n}: stream=${entry.stream} model=${entry.model} -> ${entry.decision}`)
    if (DEBUG) appendFile(MOCK_LOG, "FULL-BODY: " + JSON.stringify(body).slice(0, 20000) + "\n")

    if (!body.stream) {
      const message: any = { role: "assistant" }
      let finish = "stop"
      if (decision.kind === "tool") {
        message.content = null
        message.tool_calls = [
          { id: decision.callId, type: "function", function: { name: decision.tool, arguments: JSON.stringify(decision.args) } },
        ]
        finish = "tool_calls"
      } else {
        message.content = decision.text
      }
      const out = {
        id: `chatcmpl-e2e-${callSeq}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model ?? "mock/tester",
        choices: [{ index: 0, message, finish_reason: finish }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(out))
      return
    }

    // SSE streaming response
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" })
    const send = (obj: any) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
    const model = body.model ?? "mock/tester"
    send(openaiChunk(model, { role: "assistant", content: "" }, null))
    if (decision.kind === "tool") {
      send(
        openaiChunk(
          model,
          {
            tool_calls: [
              { index: 0, id: decision.callId, type: "function", function: { name: decision.tool, arguments: JSON.stringify(decision.args) } },
            ],
          },
          null,
        ),
      )
      send(openaiChunk(model, {}, "tool_calls"))
    } else {
      send(openaiChunk(model, { content: decision.text }, null))
      send(openaiChunk(model, {}, "stop"))
    }
    res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`)
    res.write("data: [DONE]\n\n")
    res.end()
  })
})

// ------------------------------------------------------------------ helpers
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.on("error", reject)
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port
      s.close(() => resolve(p))
    })
  })
}

let BASE = ""
async function api(pathname: string, method = "GET", body?: any): Promise<any> {
  const res = await fetch(BASE + pathname, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${pathname} -> ${res.status}: ${text.slice(0, 600)}`)
  try {
    return text ? JSON.parse(text) : undefined
  } catch {
    return text
  }
}

// ------------------------------------------------------------------ SSE client
const idleCounts = new Map<string, number>()
const sessionErrors: any[] = []
const toolResults: { sessionID: string; tool: string; status: string; output: string }[] = []
const textParts = new Map<string, Map<string, string>>() // session -> partID -> text
const permissionReplies: any[] = []

async function readEvents(): Promise<void> {
  const res = await fetch(BASE + "/event", { headers: { Accept: "text/event-stream" } })
  if (!res.ok || !res.body) throw new Error(`SSE connect failed: ${res.status}`)
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, i)
      buf = buf.slice(i + 2)
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue
        let ev: any
        try {
          ev = JSON.parse(line.slice(5).trim())
        } catch {
          continue
        }
        if (!ev || !ev.type) continue
        handleEvent(ev)
      }
    }
  }
}

function handleEvent(ev: any) {
  const p = ev.properties ?? {}
  appendFile(EVENTS_LOG, JSON.stringify(ev).slice(0, 4000) + "\n")
  if (DEBUG) log(`  event ${ev.type}`)
  switch (ev.type) {
    case "session.idle":
      idleCounts.set(p.sessionID, (idleCounts.get(p.sessionID) ?? 0) + 1)
      break
    case "session.error":
      sessionErrors.push(p)
      log(`  !! session.error ${JSON.stringify(p).slice(0, 300)}`)
      break
    case "message.updated":
      if (p.info?.role === "assistant" && p.info?.error) {
        sessionErrors.push({ via: "message.updated", error: p.info.error })
        log(`  !! assistant message error ${JSON.stringify(p.info.error).slice(0, 300)}`)
      }
      break
    case "permission.updated": {
      const perm = p as { sessionID: string; id: string; type?: string; title?: string }
      log(`  permission.updated: ${perm.type ?? ""} ${perm.title ?? ""} -> auto-allow`)
      api(`/session/${perm.sessionID}/permissions/${perm.id}`, "POST", { response: "always" })
        .then((r) => permissionReplies.push({ id: perm.id, ok: true, r }))
        .catch((e) => {
          permissionReplies.push({ id: perm.id, ok: false, e: String(e) })
          log(`  permission auto-allow failed: ${e}`)
        })
      break
    }
    case "message.part.updated": {
      const part = p.part
      if (!part) break
      if (part.type === "tool") {
        const st = part.state ?? {}
        if (st.status === "completed")
          toolResults.push({ sessionID: part.sessionID, tool: part.tool, status: "completed", output: String(st.output ?? "") })
        else if (st.status === "error")
          toolResults.push({ sessionID: part.sessionID, tool: part.tool, status: "error", output: String(st.error ?? "") })
      } else if (part.type === "text") {
        if (!textParts.has(part.sessionID)) textParts.set(part.sessionID, new Map())
        textParts.get(part.sessionID)!.set(part.id, String(part.text ?? ""))
      }
      break
    }
  }
}

// ------------------------------------------------------------------ scenario helpers
let serveProc: ChildProcess | undefined
let killed = false
function killAll() {
  if (killed) return
  killed = true
  try {
    serveProc?.kill("SIGKILL")
  } catch {}
  try {
    mockServer.close()
  } catch {}
}
function tail(file: string, lines: number): string {
  try {
    return fs.readFileSync(file, "utf8").split("\n").slice(-lines).join("\n")
  } catch {
    return `(no ${file})`
  }
}

async function turn(sid: string, label: string, script: ScriptStep[]) {
  log(`turn "${label}" on ${sid.slice(-8)}: ${script.map((s) => s[0]).join(" -> ")}`)
  const errBefore = sessionErrors.length
  const prevIdle = idleCounts.get(sid) ?? 0
  const text =
    `E2E turn (${label}). You MUST call the following tools in exactly this order, one per step, ` +
    `using exactly the given arguments. Do not call any other tools and do not skip any. ` +
    `After every tool result arrives, reply with a one-line confirmation and nothing else.\n` +
    `E2E-SCRIPT-JSON: ${JSON.stringify(script)}`
  await api(`/session/${sid}/prompt_async`, "POST", {
    model: { providerID: "mock", modelID: "tester" },
    agent: "build",
    parts: [{ type: "text", text }],
  })
  const deadline = Date.now() + TURN_TIMEOUT_MS
  for (;;) {
    if (sessionErrors.length > errBefore)
      throw new Error(`session.error during ${label}: ${JSON.stringify(sessionErrors.at(-1)).slice(0, 500)}`)
    if ((idleCounts.get(sid) ?? 0) > prevIdle) return
    if (Date.now() > deadline)
      throw new Error(`timeout waiting for idle during ${label} on ${sid}`)
    await sleep(200)
  }
}

function toolOutput(sessionID: string, toolName: string): string | undefined {
  const hits = toolResults.filter((t) => t.sessionID === sessionID && t.tool === toolName)
  return hits.length ? hits[hits.length - 1].output : undefined
}

// ------------------------------------------------------------------ main
async function main() {
  const mockPort = await freePort()
  const servePort = await freePort()
  BASE = `http://127.0.0.1:${servePort}`
  log(`tmp=${tmp} mockPort=${mockPort} servePort=${servePort}`)

  // 1. mock LLM
  await new Promise<void>((r) => mockServer.listen(mockPort, "127.0.0.1", r))
  log("mock LLM listening")

  // 2. global config
  fs.writeFileSync(
    path.join(CFG_DIR, "opencode.json"),
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        provider: {
          mock: {
            npm: "@ai-sdk/openai-compatible",
            name: "Mock",
            options: { baseURL: `http://127.0.0.1:${mockPort}/v1`, apiKey: "mock" },
            models: { tester: { name: "Mock Test Model", limit: { context: 128000, output: 8192 } } },
          },
        },
        permission: { "*": "allow" },
      },
      null,
      2,
    ),
  )
  fs.writeFileSync(
    path.join(CFG_DIR, "package.json"),
    JSON.stringify({ name: "opencode-e2e-global", dependencies: { "@opencode-ai/plugin": "1.18.15" } }, null, 2),
  )
  log("npm install in global config dir...")
  const npm = spawnSync("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], {
    cwd: CFG_DIR,
    encoding: "utf8",
    timeout: 90_000,
  })
  if (npm.status !== 0) fail(`npm install failed: ${npm.stderr?.slice(-2000)}${npm.stdout?.slice(-2000)}`)
  log("npm install done")

  // 3. project dir + plugin symlink.
  // NOTE: verified experimentally on opencode 1.18.29: plugin discovery does
  // NOT follow a symlinked directory under .opencode/plugins, nor a file
  // symlinked inside a real subdirectory; a FILE symlink directly under
  // .opencode/plugins/ does work. Also `git init` the project, otherwise
  // opencode resolves the worktree to "/" and the plugin would write
  // .agentchat outside the project.
  fs.symlinkSync(path.join(REPO, "index.ts"), path.join(PROJ, ".opencode", "plugins", "agentchat.ts"), "file")
  const gitInit = spawnSync("git", ["init", "-b", "main"], { cwd: PROJ, encoding: "utf8" })
  if (gitInit.status !== 0) fail(`git init failed: ${gitInit.stderr}`)
  fs.writeFileSync(
    path.join(PROJ, "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", permission: { "*": "allow" } }, null, 2),
  )
  fs.writeFileSync(path.join(PROJ, "README.md"), "# e2e playground\n")
  log(`project ready (plugin symlinked from ${REPO})`)

  // 4. start opencode serve.
  // Override HOME too: opencode also loads the legacy ~/.opencode config dir
  // even when XDG_CONFIG_HOME is set (verified experimentally), which would
  // leak the user's real global plugins/config into the test.
  const fakeHome = path.join(tmp, "home")
  fs.mkdirSync(fakeHome, { recursive: true })
  try {
    fs.symlinkSync(XDG_CACHE, path.join(fakeHome, ".cache"))
  } catch {}
  const env = {
    ...process.env,
    HOME: fakeHome,
    XDG_CONFIG_HOME: XDG_CONFIG,
    XDG_DATA_HOME: XDG_DATA,
    XDG_STATE_HOME: XDG_STATE,
    XDG_CACHE_HOME: XDG_CACHE,
  }
  serveProc = spawn(OPENCODE_BIN, ["serve", "--port", String(servePort), "--hostname", "127.0.0.1", "--print-logs", "--log-level", "INFO"], {
    cwd: PROJ,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  })
  serveProc.stdout?.on("data", (d) => appendFile(SERVE_LOG, d))
  serveProc.stderr?.on("data", (d) => {
    appendFile(SERVE_LOG, d)
    serveLogChunks.push(String(d))
    if (serveLogChunks.length > 400) serveLogChunks.shift()
  })
  serveProc.on("exit", (code, sig) => log(`!! opencode serve exited code=${code} sig=${sig}`))
  log("waiting for opencode serve...")
  let ready = false
  let lastPollErr = "none"
  for (let i = 0; i < 280 && !ready; i++) {
    await sleep(500)
    try {
      await api("/project/current")
      ready = true
    } catch (e: any) {
      lastPollErr = `${i * 0.5}s: ${e?.cause?.code ?? e?.code ?? e?.message ?? e}`.slice(0, 200)
    }
  }
  if (!ready) log(`last poll error: ${lastPollErr}`)
  if (!ready) fail(`opencode serve did not become ready in 60s. stderr tail:\n${tail(SERVE_LOG, 80)}`)
  log("opencode serve ready (this also proves XDG_CONFIG_HOME isolation config was accepted)")

  // 5. SSE
  const eventsDone = readEvents().catch((e) => log(`!! SSE reader ended: ${e}`))
  await sleep(300)
  log("SSE connected")

  // 6. sessions
  const A = (await api("/session", "POST", { title: "e2e-A" })).id as string
  const B = (await api("/session", "POST", { title: "e2e-B" })).id as string
  const nameA = `build-${A.slice(-4)}`
  const nameB = `build-${B.slice(-4)}`
  log(`session A=${A} (${nameA})  B=${B} (${nameB})`)
  if (nameA === nameB) fail(`session id last-4 collided: ${nameA}`)

  // 7. scripted turns
  // B registers first (chat_invite requires the target to be a registered agent)
  await turn(B, "B1 register", [["chat_status", { status: "B: idle, awaiting room invites" }]])
  const firstReq = mockLog.find((r) => String(r.tools).includes("chat_"))
  check(!!firstReq, "plugin tools visible to the model (chat_* present in request tools)", mockLog.slice(0, 3))
  const pluginLoaded = firstReq !== undefined
  if (!pluginLoaded) fail("plugin not loaded — chat_* tools absent. Check plugin discovery/symlink; serve.log for load errors")

  await turn(A, "A1 status+create+invite", [
    ["chat_status", { status: "A: setting up launch room" }],
    ["chat_room_create", { name: "launch", purpose: "ship it" }],
    ["chat_invite", { room: "launch", agents: [nameB] }],
  ])
  await turn(B, "B2 list+join+read+post+status", [
    ["chat_room_list", {}],
    ["chat_room_join", { room: "launch" }],
    ["chat_read", { room: "launch" }],
    ["chat_post", { room: "launch", message: "B here: ready to ship" }],
    ["chat_status", { status: "B: joined launch, posted" }],
  ])
  await turn(A, "A2 status", [["chat_status", { status: "A: launch room coordinated, done" }]])
  log("all turns complete")

  // 8. assertions — state files
  const agentsFile = path.join(PROJ, ".agentchat", "agents.json")
  const roomFile = path.join(PROJ, ".agentchat", "rooms", "launch.json")
  check(fs.existsSync(agentsFile), `.agentchat/agents.json exists (${agentsFile})`)
  check(fs.existsSync(roomFile), `.agentchat/rooms/launch.json exists (${roomFile})`)
  if (failures.length) reportAndExit()
  const agents = JSON.parse(fs.readFileSync(agentsFile, "utf8"))
  const room = JSON.parse(fs.readFileSync(roomFile, "utf8"))

  check(!!agents[A], `agents.json contains session A`, Object.keys(agents))
  check(!!agents[B], `agents.json contains session B`, Object.keys(agents))
  check(agents[A]?.name === nameA, `A name == ${nameA}`, agents[A]?.name)
  check(agents[B]?.name === nameB, `B name == ${nameB}`, agents[B]?.name)
  check(agents[A]?.agent === "build" && agents[B]?.agent === "build", `both agent types == "build"`, [agents[A]?.agent, agents[B]?.agent])
  check(agents[A]?.status === "A: launch room coordinated, done", `A final status`, agents[A]?.status)
  check(agents[B]?.status === "B: joined launch, posted", `B final status`, agents[B]?.status)

  check(room.first === 0, `room first == 0`, room.first)
  check(room.id === "launch" && room.name === "launch" && room.purpose === "ship it", `room id/name/purpose`, [room.id, room.name, room.purpose])
  check(room.members?.includes(nameA) && room.members?.includes(nameB), `members contain both`, room.members)
  check(Array.isArray(room.invites) && room.invites.length === 0, `invites consumed (empty)`, room.invites)
  const idx = (room.messages ?? []).map((m: any) => m.i)
  const expectedIdx = idx.map((_: any, k: number) => k)
  check(JSON.stringify(idx) === JSON.stringify(expectedIdx), `message i values are absolute & consecutive from 0`, idx)
  const texts = (room.messages ?? []).map((m: any) => `${m.from}|${m.text}`)
  check(texts.some((t: string) => t.startsWith(`${nameA}|`) && t.includes("created room") && t.includes("ship it")), `A's room-creation message present`, texts)
  check(texts.some((t: string) => t.startsWith(`${nameA}|`) && t.includes("invited") && t.includes(nameB)), `A's invite message present`, texts)
  check(texts.some((t: string) => t.startsWith(`${nameB}|`) && t.includes("B here: ready to ship")), `B's post present`, texts)
  check(agents[B]?.reads?.launch === (room.messages ?? []).length, `B read cursor == total messages`, agents[B]?.reads)

  // 9. assertions — tool outputs captured from SSE
  const invOut = toolOutput(A, "chat_invite")
  check(!!invOut && invOut.includes(`Invited: ${nameB}`), `A's chat_invite output confirms invite`, invOut)
  const joinOut = toolOutput(B, "chat_room_join")
  check(!!joinOut && joinOut.includes("Accepted invitation"), `B's join accepted the invitation`, joinOut)
  check(!!joinOut && joinOut.includes("created room"), `B's join output contains A's posted message`, joinOut)
  const postOut = toolOutput(B, "chat_post")
  check(!!postOut && postOut.includes("Posted to #launch"), `B's chat_post output`, postOut)
  const listOut = toolOutput(B, "chat_room_list")
  check(!!listOut && listOut.includes("launch"), `B's chat_room_list shows the room`, listOut)
  check(toolResults.filter((t) => t.status === "error").length === 0, `no tool errored`, toolResults.filter((t) => t.status === "error"))

  // 10. assertions — clean text endings
  check(sessionErrors.length === 0, `no session.error / assistant errors`, sessionErrors)
  check(systemIssues.length === 0, `every request keeps system messages at the start`, systemIssues)
  const aTexts = [...(textParts.get(A) ?? new Map()).values()].filter((t) => t.includes("E2E-DONE"))
  const bTexts = [...(textParts.get(B) ?? new Map()).values()].filter((t) => t.includes("E2E-DONE"))
  check(aTexts.length === 2, `A ended with text on both turns`, aTexts)
  check(bTexts.length === 2, `B ended with text on both turns`, bTexts)
  check(aTexts.some((t) => t.includes("3 tool step")), `A turn 1 confirmed 3 steps`, aTexts)
  check(bTexts.some((t) => t.includes("5 tool step")), `B turn 2 confirmed 5 steps`, bTexts)
  check(toolResults.filter((t) => t.tool.startsWith("chat_")).length >= 10, `at least 10 chat tool results captured`, toolResults.length)

  reportAndExit()
  void eventsDone
}

function reportAndExit(): void {
  killAll()
  console.log("\n================ e2e summary ================")
  console.log(`checks: ${checkCount}, failures: ${failures.length}`)
  for (const f of failures) console.log(`  FAILED: ${f}`)
  console.log(`artifacts: ${tmp}`)
  console.log(`  serve log : ${SERVE_LOG}`)
  console.log(`  mock log  : ${MOCK_LOG} (${mockLog.length} requests)`)
  console.log(`  events log: ${EVENTS_LOG}`)
  if (failures.length) {
    console.log("\n--- opencode serve stderr tail ---\n" + tail(SERVE_LOG, 120))
    console.log("\n--- mock request log tail ---\n" + tail(MOCK_LOG, 60))
    process.exit(1)
  }
  console.log("RESULT: PASS")
  process.exit(0)
}

const hardTimer = setTimeout(() => {
  console.error("\nHARD TIMEOUT exceeded — dumping diagnostics")
  console.log(`artifacts: ${tmp}`)
  console.log("\n--- opencode serve stderr tail ---\n" + tail(SERVE_LOG, 120))
  console.log("\n--- mock request log tail ---\n" + tail(MOCK_LOG, 60))
  killAll()
  process.exit(2)
}, HARD_TIMEOUT_MS)
hardTimer.unref?.()

process.on("exit", killAll)
main().catch((e) => {
  console.error(`\nHARNESS ERROR: ${e?.stack ?? e}`)
  console.log(`artifacts: ${tmp}`)
  console.log("\n--- opencode serve stderr tail ---\n" + tail(SERVE_LOG, 120))
  console.log("\n--- mock request log tail ---\n" + tail(MOCK_LOG, 60))
  killAll()
  process.exit(1)
})
