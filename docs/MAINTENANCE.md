# opencode-agentchat — maintenance manual

Audience: a future agent maintaining this plugin autonomously. This document
codifies exactly what the plugin does, every invariant the code relies on, and
every opencode integration surface that must be re-verified when opencode is
upgraded. Read this before changing anything.

## 1. What the plugin does

Gives every opencode agent session (primary agents and subagents) a unique
chat identity and 9 tools (`chat_*`) to coordinate through project-scoped chat
rooms. All state is plain JSON on disk under `<worktree>/.agentchat/`, shared
by every opencode process opened on the same worktree. No network service, no
database, no dependencies beyond `@opencode-ai/plugin`.

## 2. File map

| Path | Role |
| --- | --- |
| `index.ts` | Entire plugin: types, state helpers, 9 tools, 3 hooks. Single file by design. |
| `test/smoke.ts` | End-to-end simulation: 3 fake agent sessions + fake `client` drive the real tool `execute` functions against a temp worktree. The primary regression harness. |
| `docs/MAINTENANCE.md` | This file. |
| `package.json` | Pins `@opencode-ai/plugin` (currently `1.18.15`). `main: index.ts` (opencode loads TS via bun). |
| `tsconfig.json` | `strict`, `noEmit`, `allowImportingTsExtensions` (smoke test imports `../index.ts`). |

## 3. On-disk state schema

### `<worktree>/.agentchat/agents.json`

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
    "reads": { "refactor": 1003 } // roomId -> ABSOLUTE cursor (see I1)
  }
}
```

### `<worktree>/.agentchat/rooms/<id>.json`

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
- **I5 — name liveness.** A name blocks claiming only while its holder's
  session is alive (`client.session.get`, dead = error/absent, cached in
  `deadCache` forever — opencode session ids never revive; queries fail
  **open** when the client errors). On reclaiming a dead name, the holder's
  record is deleted **and the dead name is purged from every room's
  members/invites** before the rename.
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

## 5. Tool contracts

| Tool | Args | Behavior / guarantees |
| --- | --- | --- |
| `chat_register` | `name?` | No args → identity card. `name` matching `^[A-Za-z0-9_-]{1,32}$`: renames (I5/I6), refuses if an **alive** session holds it, reclaims dead holders. |
| `chat_agents` | — | All records, sorted; `(you)`, `[exited]`, status or last-activity fallback (`doing:`), rooms. Auto-registers caller. |
| `chat_status` | `status` | Truncated to 200 chars, timestamped. |
| `chat_room_create` | `name`, `purpose` | `id = slug(name)`; fails if id exists (same purpose → "join it" hint). Creator joins; first message records purpose. |
| `chat_room_list` | — | Per room: purpose, members, count, last message, `[member|INVITED]` + `N unread` flags for caller. |
| `chat_room_join` | `room` | Accepts invite (cleared on join), adds member, returns unseen messages, advances cursor. Re-join says "Already a member" and only shows genuinely new messages (does not burn unread). |
| `chat_invite` | `room`, `agents[]` | Caller must be member. Per-target outcome lines. Rejects unknown names and exited sessions (I5). Invite recorded as a system message in the room. **Pull-based**: invitee must call `chat_room_join`; the plugin must never inject into other sessions' turns. |
| `chat_post` | `room`, `message` | Caller must be member. 4000-char cap. Poster auto-marks the room read at their own message. |
| `chat_read` | `room`, `include_read?` | Caller must be member. Default: unseen only; advances cursor as a side effect. `include_read` → retained history (subject to I1 trim). |

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
| D | `tool.execute.before` | Fires for **plugin-defined tools too**, with `{tool, sessionID}` — this powers activity tracking. | Live session: call a chat tool, then `chat_agents` should show it as last activity. |
| E | `experimental.chat.system.transform` | Signature `(input:{sessionID?,model}, output:{system})`; called on **every** chat request, including hidden agents (title/summary/compaction) and one agent-generation site **without sessionID** (guard exists — keep it). `output.system` is rebuilt per request, so pushing per call does not accumulate. It is marked experimental: expect churn. | Typecheck; live: ask an agent "what is your chat name" — the prompt block must be reaching it. If renamed/removed, move the guidance into tool descriptions only. |
| F | `event` hook | `session.deleted` → `properties.info.id`; we prune the record and mark the name reclaimable. If the event name/payload changes, dead names simply stop auto-pruning (graceful). | Live: delete a throwaway session, check `.agentchat/agents.json` on next use. |
| G | `client.session.get` | `client.session.get({ path: { id } })` returns a result tuple; liveness = `!error && !!data`. Fail-open on thrown errors. | Typecheck `client` usage (currently typed `any` on purpose); live: `chat_agents` should not mark everyone exited. |
| H | `tool.schema` | Is the zod **v4** classic namespace — call `z.string()` on it directly; there is **no nested `.z` export** and do not import `zod` separately (version skew). | Typecheck; smoke test. |
| I | Tool result | Returning a plain string is a valid `ToolResult`. | Smoke test. |
| J | State dir writable | `.agentchat/` is created lazily under `worktree`. Unwritable fs surfaces as a tool error — acceptable, don't add silent fallbacks. | Manual. |

## 7. Regression harness (always run both before pushing)

```bash
npm install
npx tsc --noEmit        # types vs the pinned SDK
npx tsx test/smoke.ts   # 25+ step E2E incl. trim/cursor, dead-name reclaim, invite flows
```

`test/smoke.ts` fakes only the opencode surface (`ToolContext` +
`client.session.get`). Assertions cover: uniqueness refusal, invite/join/
INVITED lifecycle, unread-cursor semantics, rename membership carry-over,
dead-name purge, trim behavior at `MAX_MESSAGES` (posts 1002 messages — keep
this even though slow; it is the regression test for the worst historical
bug). When you fix any new bug, add a step here first.

Live check after any opencode upgrade (in a real session with a subagent):

1. Both agents see `chat_*` tools and the coordination prompt block.
2. `chat_agents` shows both, with correct `(you)` marking and activity.
3. create → invite → join → post → read round-trips; unread counts move.
4. `.agentchat/` files match §3 schema.

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
