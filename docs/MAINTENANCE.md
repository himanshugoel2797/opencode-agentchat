# opencode-agentchat — maintenance manual

Audience: a future agent maintaining this plugin autonomously. This document
codifies exactly what the plugin does, every invariant the code relies on, and
every opencode integration surface that must be re-verified when opencode is
upgraded. Read this before changing anything.

## 1. What the plugin does

Gives every opencode agent session (primary agents and subagents) a unique
chat identity and 10 tools (`chat_*`) to coordinate through project-scoped chat
rooms. Liveness is lease-based (quiet ~2 min → considered exited), and
`chat_spawn` starts persistent worker sessions in new zellij tabs. All state is
plain JSON on disk under `<state-root>/.agentchat/`, shared by every opencode
process opened on the same project. The **state-root** is
`PluginInput.worktree`, except opencode reports `"/"` for non-git projects —
then it falls back to `PluginInput.directory` (each opened dir keeps its own
`.agentchat`; nothing is ever written to the filesystem root). No network
service, no database, no dependencies beyond `@opencode-ai/plugin`.

## 2. File map

| Path | Role |
| --- | --- |
| `index.ts` | Entire plugin: types, state helpers, 10 tools, 3 hooks + heartbeat timer. Single file by design. |
| `test/smoke.ts` | Tool-layer simulation: 3 fake agent sessions + fake `client` drive the real tool `execute` functions against a temp worktree. Fast (~1s). |
| `test/stress.ts` | Adversarial stress/edge suite (62 checks): multi-instance races on one worktree, lease liveness/death lifecycle, `chat_spawn` guards + deterministic worker names + non-git state-root fallback, corrupt-state recovery, legacy-schema backfill, trim-boundary cursor arithmetic, path-traversal refs, limits, activity-cap. ~13s. XFAIL infrastructure exists for known-bad plugin behavior (none currently). **Cannot prove spawn actually spawns — see §7a.** |
| `test/e2e/e2e-live.ts` | TRUE end-to-end: boots a mock OpenAI-compatible LLM + real `opencode serve` in a fully isolated env (`XDG_CONFIG_HOME` **and `HOME`** overridden — opencode loads legacy `~/.opencode` regardless of XDG; keep HOME fake), then drives two real sessions through scripted `tool_calls` and asserts on-disk state + tool outputs captured from SSE. ~11s warm / ~60s cold. See `test/e2e/FINDINGS.md`. |
| `test/FINDINGS-STRESS.md`, `test/e2e/FINDINGS.md` | Bug reports from adversarial passes; keep as history + severity rationale. Both reported bugs are fixed (their checks are now hard assertions). |
| `docs/MAINTENANCE.md` | This file. |
| `package.json` | Pins `@opencode-ai/plugin` (currently `1.18.15`). `main: index.ts` (opencode loads TS via bun). |
| `tsconfig.json` | `strict`, `noEmit`, `allowImportingTsExtensions` (smoke test imports `../index.ts`). |

## 3. On-disk state schema

### `<state-root>/.agentchat/agents.json`

Object keyed by **sessionID**:

```jsonc
{
  "ses_abc123…": {
    "sessionID": "ses_abc123…",
    "name": "captain",            // unique among records (see I5)
    "agent": "build",             // opencode agent type
    "status": "coordinating",     // manual summary from chat_status
    "statusAt": 1770000000000,
    "registeredAt": 1769999000000,
    "lastSeen": 1770000123000,    // lease: refreshed by any observed activity (I5)
    "reads": { "refactor": 1003 } // roomId -> ABSOLUTE cursor (see I1)
  }
}
```

### `<state-root>/.agentchat/rooms/<id>.json`

`id` is the slug of the name: lowercase, non-alphanumeric runs → `-`.
Punctuation-only names collapse to `"room"` (acceptable; collision then
requires join instead of create).

```jsonc
{
  "id": "refactor", "name": "refactor", "purpose": "…",
  "createdBy": "captain", "createdAt": 1770000000000,
  "first": 5,        // ABSOLUTE index of messages[0]; count trimmed away
  "members": ["captain"],   // names; see I6 (names in rooms are mutable strings)
  "invites": ["be-a1b2"],   // pending; cleared on join
  "messages": [ { "i": 5, "ts": 1770000000000, "from": "captain", "text": "…" } ]
}
```

## 4. Invariants (violating any of these reintroduces a real bug — each was
a bug found in adversarial review of v0.1.0)

- **I1 — absolute message sequence / cursors.** `room.first` + array position
  = the absolute index `m.i` of each retained message. Read cursors
  (`reads[room.id]`) are absolute counts: "everything with `i < cursor` was
  seen." Unread = `messages.slice(clamp(cursor - first, 0, len))`. Trimming
  (`MAX_MESSAGES = 1000`) only splices the array head and increments
  `first` — **cursors must never be adjusted**, which is what makes stale
  cursors survive trim. Index-based cursors (v0.1.0) silently lost every
  future message for members at the cap.
- **I2 — single mutation path for messages.** Every append goes through
  `pushMessage()` (create / invite / post), which assigns absolute `i` and
  trims. An untrimmed append path (v0.1.0 invite) produced arrays >1000 and
  cursors beyond the trimmed length (`-1 unread`).
- **I3 — all room writes go through `mutateRoom(id, fn)`**, which re-reads
  the file from disk first, so a second opencode process on the same
  worktree cannot lose messages/members. Writes are atomic (tmp + rename).
- **I4 — all agent-record writes go through `saveRecord(rec)`**, which
  re-reads and merge-overwrites by sessionID (never blind whole-map
  overwrite; v0.1.0 clobbered concurrent registrations).
- **I5 — name liveness is a LEASE.** opencode never deletes finished
  subagents from SQLite and `session.get` keeps returning them, so the server
  list is NOT a liveness signal. Instead: any observed activity (tool
  execution, chat request, chat tool call) stamps an in-memory `seen` map
  (`markSeen`) and the record's `lastSeen` on disk (throttled flushes + a
  self-heartbeat every `HEARTBEAT_MS = 30s`, unref'd timer). A session is
  **dead** if (a) `session.deleted` marked it (deadCache, permanent — opencode
  ids never revive), or (b) its lease is `>= STALE_MS = 120s` old (in-memory
  `seen` first, then disk `lastSeen`); only fresh leases get the
  `client.session.get` probe, and probe failures **fail open** (alive). Env
  override `AGENTCHAT_STALE_MS` (for tests). A name/holder is reclaimable once
  dead: `purgeRecord()` deletes the record **and sweeps the name from every
  room's members/invites**. **After the liveness `await`, `chat_register` and
  `chat_spawn` MUST re-read `agents.json` and re-check the claim** (excluding
  self and the dead holder) before purging — everything after that point is
  synchronous. Omitting the recheck reintroduced a double-claim race
  (FINDINGS-STRESS Bug 1, regression check `03`). Lease tests must read
  through an instance that never saw the session (the in-memory map defeats a
  backdated disk stamp) — see stress checks `04a3`/`SP3`.
- **I6 — renames** (`chat_register name=`) sweep `members`/`invites` in all
  rooms. Message history and read cursors intentionally keep working:
  history stores the old name as a label; cursors are keyed by room id.
- **I7 — corrupt state quarantines, never crashes.** A JSON parse failure
  renames the file to `<name>.corrupt-<ms>` and falls back to empty.
  `normalizeRoom` backfills `first`/`members`/`invites`/`messages` so older
  room files (pre-`first` schema) load correctly — that is the migration
  mechanism; extend it rather than writing a separate migration when the
  schema changes again.
- **I8 — activity map is bounded** (`MAX_ACTIVITY = 200`, evict-oldest) and
  is only fed by `tool.execute.before`. Never add synthetic activity entries
  (v0.1.0's system-transform "chat-system" write lied in `chat_agents`).
- **I9 — room identity is the FILENAME.** `normalizeRoom` skips any room file
  whose embedded `id` mismatches its filename or fails `^[a-z0-9-]+$`, and
  `roomFile()` throws on ids that fail the same regex — hand-edited files can
  never be written back outside `rooms/` (FINDINGS-STRESS Bug 2, regression
  check `09e`). Keep both guards; they are defense-in-depth against an
  attacker who can already write `.agentchat/`.
- **I10 — the state-root is never `/`.** `PluginInput.worktree === "/"` (a
  non-git project, verified live) must resolve state to
  `PluginInput.directory`: separate non-git projects must not share
  rooms/identities via a filesystem-root `.agentchat/`, nothing is ever
  written to `/`, and `chat_spawn` cds into the same resolved root.
  Regression checks `RF1`/`RF2`.

## 5. Tool contracts

| Tool | Args | Behavior / guarantees |
| --- | --- | --- |
| `chat_register` | `name?` | No args → identity card. `name` matching `^[A-Za-z0-9_-]{1,32}$`: renames (I5/I6), refuses if a lease-**alive** session holds it, reclaims dead holders (I5 recheck + `purgeRecord`). Honors `AGENTCHAT_NAME` at first registration (spawned workers). |
| `chat_agents` | — | All records, sorted; header line `name [type: X]`, then `liveness: alive / exited / (you)` (lease per I5, fail-open), `doing:` (status, last-activity, `idle`, or `-`), `last seen` (`max(lastSeen, activity.ts, statusAt)`), `rooms`. Auto-registers caller. |
| `chat_status` | `status` | Truncated to 200 chars, timestamped. |
| `chat_room_create` | `name`, `purpose` | `id = slug(name)`; fails if id exists (same purpose → "join it" hint). Creator joins; first message records purpose. |
| `chat_room_list` | — | Per room: purpose, members, count, last message, `[member|INVITED]` + `N unread` flags for caller. |
| `chat_room_join` | `room` | Accepts invite (cleared on join), adds member, returns unseen messages, advances cursor. Re-join says "Already a member" and only shows genuinely new messages (does not burn unread). |
| `chat_invite` | `room`, `agents[]` | Caller must be member. Per-target outcome lines. Rejects unknown names and exited sessions (I5). Invite recorded as a system message in the room. **Pull-based**: invitee must call `chat_room_join`; the plugin must never inject into other sessions' turns. |
| `chat_post` | `room`, `message` | Caller must be member. 4000-char cap. Poster auto-marks the room read at their own message. |
| `chat_read` | `room`, `include_read?` | Caller must be member. Default: unseen only; advances cursor as a side effect. `include_read` → retained history (subject to I1 trim). |
| `chat_spawn` | `name`, `prompt?`, `room?` | Requires `$` presence (real-host sentinel) and `ZELLIJ` env; outside zellij → refusal string. Reclaims a stale name holder (I5 recheck + `purgeRecord`), refuses a lease-alive holder. Executes (via `execFile`, RAW argv tokens) `zellij action new-tab --name <n> -- zsh -lc "cd -- <state-root> && export AGENTCHAT_NAME=<n> [AGENTCHAT_ROOM=<id>]; exec opencode . --prompt <p>"` — values inside the zsh script are `shq`-quoted, argv tokens are NOT. The worker claims its name/room deterministically in `ensureAgent` (`AGENTCHAT_ROOM` auto-joins via `maybeAutoJoin`). No `$` (test harness) → returns the exact `[dry-run]` command instead. Verified live end-to-end on opencode 1.18.29 + zellij 0.44.3. |

Room refs accept exact id, exact name, then case-insensitive name; failures
list available rooms.

## 6. Hooks & opencode integration surface — VERIFY ON EVERY OPENCODE UPGRADE

Each row: what we rely on, what was verified against opencode 1.18.29 /
plugin SDK 1.18.15, and how to re-verify. If a check fails, fix `index.ts`
and this table, re-run §7, and note the change in git history.

| # | Surface | Relied on | Verify with |
| --- | --- | --- | --- |
| A | Plugin loading | Default export is an async factory returning `Hooks`; `satisfies Plugin` compiles. Auto-discovered in `.opencode/plugins/*.ts` and global config dir. | `npx tsc --noEmit`; load it in a live opencode and check for load errors. |
| B | `tool` hook keys = **raw tool ids** | `chat_post` reaches the model unprefixed (no `plugin_` namespace). Verified by inspecting the opencode binary's registry wiring (`Object.entries(…plugin.tool…)` uses keys verbatim; only MCP tools are prefixed `server_tool`). If a future version namespaces them, update every `chat_*` mention in descriptions and the §7 prompt block. | `grep -a "chat_post" $(which opencode)` is not conclusive — check in a live session: ask the agent to call `chat_room_list` with no args. |
| C | `ToolContext` fields | `sessionID`, `agent`, `messageID`, `directory`, `worktree`, `abort`, `metadata`, `ask` exist on every tool execute. Identity is keyed on `sessionID`; display default is `<agent>-<sessionID suffix>`. | Typecheck against bumped SDK (`index.ts` imports `ToolContext`). |
| C2 | `PluginInput` state root | Factory receives `{ client, worktree, directory, $ }`. **`worktree` is `"/"` for non-git projects** (verified live) — I10 fallback to `directory` must stay; a future version that fixes `worktree` itself is fine, the guard degrades to a no-op. | Live: `mkdir /tmp/x && cd /tmp/x && opencode` (no git) — state must land in `/tmp/x/.agentchat/`, never `/.agentchat`. Stress `RF1`/`RF2`. |
| D | `tool.execute.before` | Fires for **plugin-defined tools too**, with `{tool, sessionID}` — this powers activity tracking. | Live session: call a chat tool, then `chat_agents` should show it as last activity. |
| E | `experimental.chat.system.transform` | Signature `(input:{sessionID?,model}, output:{system})`; called on **every** chat request, including hidden agents (title/summary/compaction) and one agent-generation site **without sessionID** (guard exists — keep it). We also stamp the lease + classify self (primary vs sub) here, so the heartbeat works for sessions that only chat. `output.system` is rebuilt per request, so mutating per call does not accumulate. **Hard requirement:** never leave `output.system` with >1 entry — opencode emits each entry as its own `system`-role message, and SGLang/vLLM reject any `system` message that is not the first ("System message must be at the beginning."). Merge the block into `output.system[0]` (or push only when the array is empty), as the current impl does. | Typecheck; live: ask an agent "what is your chat name" — the prompt block must be reaching it. e2e-live asserts single-system-at-start on every mock request. If renamed/removed, move the guidance into tool descriptions only. |
| F | `event` hook | Event payload shapes (verified in SDK `types.gen.d.ts`): `session.deleted` → `properties.info.id`; `session.status`/`session.idle` → `properties.sessionID`; `message.updated` → `properties.info.sessionID`; `message.part.updated` → `properties.part.sessionID`. We use the latter to **stamp the lease** (`eventSessionID` helper checks all four shapes — keep it updated if events are renamed), and `session.deleted` to prune the record permanently (deadCache). If event names/payloads change, leases stop extending via events (graceful; tool/system hooks still stamp). | Live: run any tool in another session; check `lastSeen` in `.agentchat/agents.json` moves. Delete a throwaway session, check its record vanishes from `agents.json` on next use. |
| G | `client.session.get` | `client.session.get({ path: { id } })` returns a result tuple; probe = `!error && !!data`. Used ONLY for fresh-lease sessions (I5); thrown errors fail open (alive). NOTE: finished subagents stay listed forever — never treat the list as liveness by itself. | Typecheck `client` usage (currently typed `any` on purpose); live: `chat_agents` should not mark everyone exited, and a finished subagent should disappear after ~2 quiet minutes. |
| G2 | `chat_spawn` process launch | Uses **`node:child_process.execFile` with a raw argv array**, not BunShell. Live-discovered traps (all real failures, do not reintroduce): (1) `$\`${wholeCmd}\`` puts the ENTIRE string in argv[0] → "command not found"; (2) `$.nothrow()` returns an object WITHOUT `.quiet()` in opencode 1.18.29's BunShell → chained calls crash the tool; (3) BunShell rejection carries `stderr` as a Buffer, not a function; (4) `shq()`-quoting argv tokens for execFile makes zsh exec the literal quoted string as the program name → worker pane dies instantly. `shellHandle` presence is kept ONLY as the "running inside a real opencode host" sentinel (headless stress keeps the dry-run path). | Live (the ONLY acceptable verification): from inside zellij, run `opencode run 'call chat_spawn …'` and confirm a new tab opens, the worker registers under its `AGENTCHAT_NAME`, posts to the room, and `chat_agents` shows it alive. Stress `SP3b` pins only the command SHAPE, never execution. |
| G4 | opencode TUI argv | `opencode <msg>` does NOT send a message — the positional is `[project]`. Initial instruction must go via `opencode . --prompt '<p>'` (keeps the tab as a live interactive worker; `opencode run` is one-shot). Verified 1.18.29. | Live spawn (see G2). |
| G3 | `setInterval` heartbeat | Plugin process may outlive sessions; timer is `unref()`d and persists `lastSeen` + flushes `seen` every 30s. If the bun host freezes timers for idle plugins, leases expire too eagerly → `AGENTCHAT_STALE_MS` makes this testable. | Live: keep one session idle >2 min in a room, confirm `chat_agents` from another session still shows it alive after ~30s heartbeats. |
| H | `tool.schema` | Is the zod **v4** classic namespace — call `z.string()` on it directly; there is **no nested `.z` export** and do not import `zod` separately (version skew). | Typecheck; smoke test. |
| I | Tool result | Returning a plain string is a valid `ToolResult`. | Smoke test. |
| J | State dir writable | `.agentchat/` is created lazily under the state-root (worktree, or `directory` for non-git per I10/C2). Unwritable fs surfaces as a tool error — acceptable, don't add silent fallbacks. | Manual. |

## 7. Regression harness (always run all three before pushing)

```bash
npm install
npx tsc --noEmit          # types vs the pinned SDK
npx tsx test/smoke.ts     # ~1s   tool-layer happy-path + trim/cursor basics
npx tsx test/stress.ts    # ~13s  62 adversarial checks (races, lease liveness, spawn guards + root-fallback, corrupt, legacy, boundaries, refs)
npx tsx test/e2e/e2e-live.ts   # ~11s warm / ~60s cold — REAL opencode serve + scripted mock LLM
```

### 7a. What the automated suites CANNOT prove (mandatory manual checks)

Unit/stress suites inject a fake `client` and **omit `$` (BunShell)**, so
`chat_spawn` takes its `[dry-run]` branch: they verify the emitted command
*shape* and the guards, never that a tab actually opens or a worker registers.
Likewise no suite exercises a real zellij, a non-git `worktree="/"`, or the
`opencode . --prompt` argv contract. **After ANY change to spawn/zellij/argv/
`PluginInput` handling — or before tagging a release that touched them — run
the LIVE spawn check:**

1. From inside a real zellij session, in the repo, drive a throwaway session:
   `opencode run 'call chat_spawn name=live-worker-1 room=<x> prompt="<join
   room, post a marker, set status>"'`.
2. Confirm ALL of: a new zellij tab opens (`zellij action list-tabs` shows it);
   the tab's process is `opencode . --prompt ...` (`ps -eo ppid,args |
   awk '$1==<server>'`), it **stays alive**; `.agentchat/agents.json` gains a
   `live-worker-1` record via `AGENTCHAT_NAME`; the marker message appears in
   the room file; `chat_agents` (from your own session) lists `live-worker-1`
   as **alive**. Finished `opencode run` drivers must show **exited**.
3. Close the spawned tabs (`zellij action go-to-tab-by-id N; close-tab`) and
   prune the test records so shared state isn't polluted.

Three real blockers were caught ONLY by this live loop (v0.3.1): BunShell
argv[0] misuse, `shq`-quoting leaking into `execFile` argv (instant pane
death), and the TUI positional being `[project]` not the message. Trust the
live check over green suites for these surfaces. Also do the non-git C2 check
(`mkdir /tmp/x && cd /tmp/x && opencode` → state under `/tmp/x`, never `/`).

`test/smoke.ts` fakes only the opencode surface (`ToolContext` +
`client.session.get`). Assertions cover: uniqueness refusal, invite/join/
INVITED lifecycle, unread-cursor semantics, rename membership carry-over,
dead-name purge, trim behavior at `MAX_MESSAGES` (posts 1002 messages — keep
this even though slow; it is the regression test for the worst historical
bug). When you fix any new bug, add a step to smoke or stress first.

`test/e2e/e2e-live.ts` is the authoritative check for the §6 live surfaces —
it proves B (raw tool ids reach the model), D (`tool.execute.before` fires
for plugin tools), E (system prompt block reaches sessions), G
(lease liveness stamping via real requests) without a real LLM. Notes for keeping it green:

- Isolation needs BOTH `XDG_CONFIG_HOME` and `HOME` overridden (opencode
  still loads legacy `~/.opencode` otherwise).
- The plugin cache (`XDG_CACHE`, `/tmp/opencode-agentchat-e2e-cache`) is
  deliberately SHARED across runs: opencode installs the plugin's npm deps
  on first load and cold-cache registry fetches caused 10–160s startup
  flakiness. Delete it to test cold-start behavior.
- The mock drives turns by counting `role:"tool"` messages after the last
  user message; `stream:true` single-chunk `tool_call` deltas work with
  `@ai-sdk/openai-compatible` (v1.18.29). If a future opencode changes the
  provider wire format, this harness fails FIRST — that is by design.
- If plugin discovery regresses upstream, note: dir-symlinks under
  `.opencode/plugins/` are NOT discovered (only direct file symlinks were);
  `worktree` resolves to `/` unless the project is `git init`ed (the plugin
  falls back to `directory` per I10/C2 — keep it that way so non-git projects
  still work).

Manual live check if e2e-live can't run (no `opencode` binary available):
see git history of this section (pre-0.2 checklist).

## 8. Design decisions (don't casually reverse these)

- **Pull-based invites.** Invitations are passive records; no mechanism may
  interrupt or prompt another agent's session. opencode plugins have no
  supported "inject message into a live turn" API — using the client to
  `prompt` other sessions would burn user tokens and is out of scope.
- **Everything synchronous fs inside tool bodies.** Within one process this
  gives effectively atomic read-modify-write; cross-process safety comes
  from I3/I4 re-reads + atomic renames. No locks; last-writer-wins for
  non-mergeable fields is an accepted trade-off.
- **Fail-open liveness.** A failing `session.get` must never block invites.
  Liveness is deliberately a quiet-lease, not a process list: opencode keeps
  finished subagents in SQLite forever, and idle-but-open persistent sessions
  (e.g. zellij tabs) must remain "alive".
- **Persistent workers are visible interactive sessions.** `chat_spawn` only
  ever opens zellij tabs the user can see and close — the plugin must never
  start headless hidden agent processes (matches §8's pull-based no-injection
  spirit: a worker acts only when its own turn runs).
- **State in the project tree** (not global) so parallel sessions and git
  users share/inspect it. `.agentchat/` is gitignored *in this repo only*;
  users decide for their own projects.
- **Single-file plugin.** Keep `index.ts` self-contained; opencode plugin
  distribution (bun, no build step) is simplest with one module.

## 9. Release flow

```bash
# after fixes: update version in package.json + git tag
gh repo view # remote: github.com/himanshugoel2797/opencode-agentchat
git commit -am "…" && git push
gh release create v0.1.N --generate-notes
```

If published to npm, the README install becomes
`"plugin": ["opencode-agentchat@X.Y.Z"]`.

## 10. Known limitations / backlog ideas

- Invited-but-unjoined agents aren't nudged (pull model, §8).
- Rooms can't be archived/deleted; history only trims.
- Read receipts are per-record cursors only (no cross-device sync beyond the shared tree).
- `MAX_MESSAGES` history is lossy by design; a future version could spill trimmed messages to `rooms/<id>.archive.jsonl` (keep absolute `i` when you do).
- Slug-only room identity means "Auth refactor" and "auth-refactor" collide; message-history rename labels are not disambiguated.
- `chat_spawn` only works inside zellij (no tmux/no-terminal fallback yet); spawned workers are full interactive sessions, not headless — the user closes their tabs.
- A spawned worker that never calls a chat tool holds no lease and only stays "alive" via its heartbeat while the process runs; if opencode suspends plugin timers, expect it to show exited until it next acts.
