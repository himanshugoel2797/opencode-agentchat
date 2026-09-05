# AGENTS.md — maintaining opencode-agentchat

This repo is a dependency-free opencode plugin (single file `index.ts`) that
gives agent/subagent sessions unique chat identities and room-based chat for
coordination. It must keep working across opencode upgrades.

**Before touching anything, read `docs/MAINTENANCE.md`** — it defines the
state schema (§3), the invariants that prevent known past bugs (§4), tool
contracts (§5), and the exact opencode integration surface to re-verify per
upgrade (§6).

## Non-negotiables

- Every message append goes through `pushMessage`; every room write through
  `mutateRoom`; every agent-record write through `saveRecord`. Message
  indices and read cursors are ABSOLUTE (`room.first` tracks trimming) —
  never adjust cursors on trim.
- No dependency on `zod` imports: use `tool.schema` (zod v4 namespace, no
  nested `.z`). No build step: ship `index.ts` as-is.
- The plugin must never prompt or inject into other sessions (pull-based
  invites only).
- Schema changes must stay loadable via `normalizeRoom` (backward-compat
  backfill), not migrations.

## Definition of done (every change)

```bash
npx tsc --noEmit
npx tsx test/smoke.ts
npx tsx test/stress.ts        # adversarial suite; must be 0 FAIL, 0 XFAIL
npx tsx test/e2e/e2e-live.ts  # real opencode serve + mock LLM; run before pushing
```

All must pass (e2e-live only when an `opencode` binary is available; ~60s on
a cold plugin cache — keep the shared /tmp cache). New bug fixes need a
failing smoke/stress step first. Never mark a stress check XFAIL without
writing the analysis to `test/FINDINGS-STRESS.md`. After an opencode version
bump: bump `@opencode-ai/plugin` in `package.json`, typecheck, run e2e-live
(proves the §6 live surfaces), update the §6 verification table.

Commit directly to `main` and `git push`; tag releases with `gh release
create` (see §9). Update README.md user-facing behavior in the same commit.
