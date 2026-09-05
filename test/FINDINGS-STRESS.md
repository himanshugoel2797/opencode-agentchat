# FINDINGS-STRESS — adversarial stress/edge-case pass over `index.ts`

Harness: `test/stress.ts` (run `npx tsx test/stress.ts`, ~15s, exit 0 = green).
Latest run: **50 PASS, 0 FAIL, 2 XFAIL** across 52 checks. `npx tsc --noEmit` clean;
`test/smoke.ts` still exits 0.

Method note: to exercise genuine cross-process races we instantiate the plugin
**multiple times against one temp worktree** (distinct `deadCache`/`activity`,
shared disk) and drive their tools with `Promise.all`. Because `index.ts` does
all disk I/O synchronously *inside* each tool body, the only real interleaving
surface is the `await sessionAlive(...)` calls in `chat_register` / `chat_invite`
/ `chat_agents` — exactly where two processes' writes can interleave. Findings
below are the only places that interleave produced an invariant violation or an
unsafe path; everything else held.

---

## Real bugs (both FIXED by central integration; checks `03`/`09e` are now hard assertions)

> **FIXED.** Bug 1: `chat_register` now re-loads `agents.json` and re-checks the
> claim after the liveness `await` (excluding self and the dead holder) before
> writing — the post-await section is fully synchronous, closing the in-process
> window; cross-process residual is covered by MAINTENANCE §8's accepted
> last-writer-wins trade-off. Bug 2: room identity is now the FILENAME;
> `normalizeRoom` skips files whose embedded `id` mismatches the filename or
> fails `^[a-z0-9-]+$`, and `roomFile()` throws on unvalidated ids (new
> invariant I9).

### Bug 1 — Concurrent dead-name reclaim double-claims the name (check `03`) — SEVERITY: MEDIUM — FIXED

**Symptom.** Two opencode processes run `chat_register(name="hero")` at the same
time while `"hero"` is held by a *dead* session. Both succeed. `agents.json`
ends up with **two records sharing the name `hero`**, violating invariant **I5**
("name unique among records").

**Root cause** (`index.ts`, `chat_register.execute`, lines ~287–313). The reclaim
path is:
```
const holder = ...find(a => a.name === name && a.sessionID !== me)   // read
if (holder) { if (await sessionAlive(holder.sessionID)) return taken // <-- AWAIT
              ...delete holder... }
rec.name = name; saveRecord(rec)                                     // write
```
`sessionAlive` is an `await`. With a dead holder, process A suspends at the
await; process B (separate plugin instance) runs its own `chat_register`, sees
the *same still-present dead holder*, suspends at its own await. Both resumes
take the "holder is dead → reclaim" branch; each deletes the holder's record and
renames itself to `hero`. `saveRecord` merge-writes by `sessionID` (I4), so
*both* renames persist → duplicate names.

**Severity: MEDIUM.** Breaks I5. The pull-based model uses names as invitation
addresses (`chat_invite(agents=["hero"])`, `chat_agents` listing, room
membership). A duplicate name makes invites/membership ambiguous — `byName` map
in `chat_invite` (lines ~499) silently collapses the collision to one holder, so
the *other* identically-named agent can never be invited or correctly resolved.
Triggers are a real concurrency window (two agents racing to adopt a common
name like "lead" / "build" right after a session exits), not exotic.

**Suggested fix direction (for the plugin owner, not the harness).** After the
`await sessionAlive(...)` returns false, **re-read** `loadAgents()` and re-check
that `name` is *still* unclaimed by a live session before writing — i.e. convert
check→await→write into check→await→recheck→write (CAS-style optimistic retry),
and make the reclaim delete + rename a single merge-verified write. A cross-file
lock is overkill; an idempotent recheck after the only await closes the observed
window because the post-await section is synchronous.

### Bug 2 — Crafted `id` inside a room JSON escapes `rooms/` on write (check `09e`) — SEVERITY: LOW — FIXED

**Symptom.** A hand-written `rooms/pwnfile.json` whose `id` field is
`"../../evil-pwn"` is loaded, resolved by name, and later **written back** via
`roomFile(room.id)` = `path.join(roomsDir, "../../evil-pwn.json")` — landing at
`<worktree>/evil-pwn.json`, outside `.agentchat/`. Reproduced by a `chat_register`
rename sweep that rewrites every room (`index.ts` lines ~314–325), and equally by
any `mutateRoom`/`writeJSON(roomFile(...))` against a loaded room.

**Root cause.** `roomFile(id)` trusts `id` read from disk. `normalizeRoom`
validates `id` is present but never rejects `..`/`/`. Tool-supplied ids are safe
(checks `09c`/`09c2`/`09c3` all pass — names are slugged, refs are never joined
into paths), so the *only* entry point is an already-crafted file on disk.

**Severity: LOW.** An attacker who can write arbitrary files under
`.agentchat/rooms/` already has project-tree write access; this only lets that
one write *escape* the chat dir (a confined path-traversal primitive). No
tool-driven input reaches it. Still worth hardening for defense-in-depth.

**Suggested fix (plugin owner).** Validate on load: in `normalizeRoom`, drop
rooms whose `id` fails `/^[a-z0-9-]+$/` (matches `slug()` output), or resolve
`roomFile` and assert the result stays within `roomsDir` before `writeJSON`/
`renameSync`. One guard in `roomFile` closes both the write-back and resolve
paths at once.

---

## Confirmed-SAFE behaviors (stress held; each is a PASS, listed for the maintainer)

- **Same-name concurrent `chat_room_create`** (01a–01c): exactly one creates,
  other gets `is taken`; sole-member = winner; same-purpose retry returns the
  "already exists … join it" hint. Creation check→write is synchronous (no await
  inside), so no lost room.
- **Interleaved concurrent posts / invites** (02, CI, 10j): `mutateRoom` re-reads
  from disk on every write (I3), so N posts from 2 processes never lose a
  message; absolute `i` stays strictly consecutive with `first + length ===
  total`; concurrent joins keep `members` set-unique; an invite whose liveness
  await straddles concurrent posts appends its notice last with no gap.
- **Concurrent auto-registration** (CM): `saveRecord` merge-by-`sessionID` (I4)
  preserves both registrations from two processes.
- **Liveness** (04a–04d): dead session → `[exited]` in `chat_agents`;
  `chat_invite` to it → `session has exited`; reclaim purges the dead holder's
  record **and** its name from every room's `members`/`invites` (I5). A
  **throwing** client fails open (treated alive: `idle`, invite succeeds).
- **`session.deleted` event** (05a–05d): prunes the record from `agents.json`;
  because state is disk-backed with no cross-instance registry cache, the *other*
  instance sees the prune on its next load. `deadCache` is correctly per-instance
  (instance that saw the event keeps `[exited]`; the other still sees it alive via
  its own liveness probe) — expected, not a bug.
- **Corrupt state** (06a–06d): garbage in `agents.json` and a room file → next
  call renames each to `*.corrupt-<ms>`, excludes them, recovers as an empty
  registry, no throw, no repeated quarantine (I7).
- **Legacy schema** (07a–07e): rooms with no `first` and messages with no `i`
  load via `normalizeRoom` backfill; cursors ahead of total clamp to 0 unread
  (no negative, no `NaN`); missing `invites`/`messages` behave empty; rewritten
  file gains `first=0`.
- **Trim / cursor boundary** (08a–08f): cap holds at exactly `MAX_MESSAGES`;
  an invite notice pushed at the cap trims `first 0→1` correctly; a member whose
  cursor equals total-before-invite sees **exactly 1** unread after; at the
  `cursor == first` boundary and after trim passes the cursor, unread stays
  exactly `1000` (all retained) with no off-by-one/negative; read-after-trim
  returns 1000 lines and marks read cleanly (I1/I2).
- **Room ref resolution & traversal** (09a–09d): exact-id beats another room's
  exact-name; case-insensitive name fallback works; every traversal-bearing
  *name* (`../escape`, `%2e%2e%2f…`, `....//…etc/passwd`) is slugged to a safe
  in-dir id; every traversal *ref* is rejected with `No room` for both join and
  post; **fs-listing diff confirms no file created outside `.agentchat/`** from
  any tool-driven path; punctuation-only names collapse to id `room` and collide
  as documented.
- **Limits** (10a–10i): status→200 chars, message→4000 chars (verified on disk),
  whitespace trimmed, 33-char/spaced/blank names rejected, rename-to-own-name is
  a no-op, self-invite & already-member invite both say `already a member`,
  unknown name says `not a registered agent`.
- **Activity cap** (11): 250 sessions through `tool.execute.before` → map bounded
  at `MAX_ACTIVITY=200`; the 50 evicted sessions fall back to `idle` /
  `last seen: never` in `chat_agents` with no crash (verified indirectly, since
  the map is private).
- **Read idempotency** (12a–12c): second `chat_read` says `no new`; poster
  auto-marks its own room read; two members at different cursors see disjoint
  correct unread sets.

## Harness caveats (honesty for the maintainer)
- Both XFAILs reproduce *reliably* here because the fake `client.session.get`
  injects a controlled delay that pins the await open across the sibling
  instance's call. In real opencode the window is the real network/IPC latency of
  `session.get` — smaller but non-zero; Bug 1 in particular is a genuine
  (if intermittent) cross-process race, not an artifact.
- The harness cannot inspect `activity`/`deadCache` internals; check 11 infers
  the cap indirectly from `chat_agents` output, which is the honest observable.
