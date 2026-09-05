# FINDINGS — e2e harness (test/e2e/e2e-live.ts)

Run: `npx tsx test/e2e/e2e-live.ts` (exit 0 = pass, ~20s, hard timeout 165s inside).
Status: **fully working, no skips.** Last run: 31/31 checks PASS.

## Plugin bugs found

None. All tested invariants held live: lazy registration with
`<agent>-<last4>` names, invite → join acceptance (invite consumed),
absolute message indices consecutive from 0, `first=0`, read cursors,
`chat_read` after `chat_room_join` correctly reports "no new messages",
tool outputs captured via SSE matched the on-disk state.

## Opencode integration findings (re-verify per upgrade; relevant to MAINTENANCE §6/§7)

1. **Plugin file discovery and symlinks (opencode 1.18.29).** A symlinked
   *directory* at `.opencode/plugins/agentchat -> repo/` is NOT loaded;
   neither is a file symlink inside a real subdirectory
   (`.opencode/plugins/agentchat/index.ts`). A FILE symlink directly under
   `.opencode/plugins/` (agentchat.ts -> repo/index.ts) IS loaded and the
   plugin works fully. Harness uses the file-symlink form (deviation from
   the task's suggested dir-symlink, verified experimentally).
2. **`worktree` resolution depends on git.** For a non-git project dir,
   `GET /project/current` reports `worktree:"/"`, i.e. the plugin's
   `worktree` param would place `.agentchat` OUTSIDE the project. Harness
   runs `git init` in the temp project. Worth noting in MAINTENANCE: the
   plugin inherits opencode's git-based worktree resolution.
3. **XDG_CONFIG_HOME alone does not isolate.** opencode also loads the
   legacy `~/.opencode/opencode.json` (and its plugins) even when
   `XDG_CONFIG_HOME` points elsewhere — first harness run leaked user
   global plugins into the session tool list. Full isolation in the
   harness requires `HOME` (plus XDG data/state/cache) pointed at temp dirs.
4. **Mock provider works.** `@ai-sdk/openai-compatible` under
   `provider.mock.options.baseURL=<mock>/v1`: opencode always sends
   `stream:true`; SSE chunks with a single `delta.tool_calls` fragment
   (id+name+full arguments in one chunk) + `finish_reason:"tool_calls"`
   drive deterministic scripted turns; tool results come back as
   `role:"tool"` messages after the user message (this is what the mock's
   "count tool messages after last user message" script-replay relies on).
5. **Permissions.** chat_* plugin tools never emitted `permission.updated`
   (config has `"permission": {"*": "allow"}` and the harness also
   auto-responds `"always"` to any `permission.updated`, so both belt and
   suspenders are in place; neither was needed).
6. **Turn completion detection.** `POST /session/{id}/prompt_async` +
   `session.idle` on `GET /event` (SSE) is reliable; tool outputs are on
   `message.part.updated` parts (`part.state.status==="completed"`,
   `part.state.output`). `session.error` and `message.updated` with
   `info.error` cover failure signaling.

## Harness mechanics (documented for later central integration)

- Mock LLM decides from conversation state (no session identification
  needed): the prompt text embeds `E2E-SCRIPT-JSON: [[tool,args],...]`;
  each request replays the next not-yet-executed step; when all are done
  it returns a plain-text `E2E-DONE ...` turn. Non-scripted requests (e.g.
  title generation) get `"ack"`.
- Scenario: B registers first (chat_invite requires the target to be a
  registered agent), then A (status, room create "launch"/"ship it",
  invite `build-<B last4>`), then B (list/join/read/post/status), then A
  status. Names asserted as `build-` + last 4 chars of sessionID.
- Artifacts kept per run in a printed temp dir: `serve.log`,
  `mock-requests.log` (every request with decision), `events.log` (every
  SSE event), plus the project's `.agentchat/`.
- Typecheck the file manually (repo tsconfig only includes `test/*.ts`):
  `npx tsc --noEmit --strict --target ES2022 --module ESNext --moduleResolution bundler --types node --skipLibCheck --esModuleInterop test/e2e/e2e-live.ts`
- Env knobs: `E2E_DEBUG=1` (full mock request bodies + per-event logs).
