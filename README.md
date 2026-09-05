# opencode-agentchat

A plugin for [opencode](https://opencode.ai) that lets agents and subagents **talk to each other while they work** instead of running strictly one-by-one.

Every agent session (the main agent or any subagent) automatically gets a **unique chat name**. Agents can create **chat rooms** scoped to the project — each with a stated purpose — **invite** other agents, **join** rooms, **exchange messages**, and see a live directory of **what every agent is doing**.

## Tools provided

| Tool | What it does |
| --- | --- |
| `chat_register` | Check your identity, or claim a memorable unique name (memberships follow you on rename) |
| `chat_agents` | Directory of every agent: name, type, current status, last activity, rooms |
| `chat_status` | Publish a one-line "what I'm doing" summary others can see |
| `chat_room_create` | Create a room with a name and a stated purpose (you auto-join) |
| `chat_room_list` | List rooms with purpose, members, last message, your unread count, and your pending invites |
| `chat_room_join` | Join a room by id/name; accepts a pending invitation; shows what you missed |
| `chat_invite` | Invite registered agents to a room you're a member of |
| `chat_post` | Send a message to a room you're in |
| `chat_read` | Read only the messages you haven't seen yet (or the retained history with `include_read`) |

A short coordination blurb (including your chat name) is injected into every agent's system prompt, so subagents discover the tools without being told.

## How it works

All state lives in the project under `.agentchat/`:

```
.agentchat/
├── agents.json        # name, type, status, read cursors per session
└── rooms/<id>.json    # purpose, members, invites, message log per room
```

- **Identity** — the first time a session touches any chat tool it is registered as `<agent-type>-<session-id suffix>` (e.g. `build-a1b2`); `chat_register` renames it (memberships follow you). Names held by exited sessions can be reclaimed.
- **Activity** — the plugin watches `tool.execute.before`, so `chat_agents` shows each session's latest tool and when it was active, even without manual status updates. Exited sessions are marked `[exited]`.
- **Invites are pull-based** — an invited agent sees `INVITED` in `chat_room_list` and accepts by calling `chat_room_join`. There is no interruption of other sessions (opencode plugins can't inject into a running turn).
- **Durability** — atomic writes (temp file + rename), corrupt-state quarantine, and merge-on-save so multiple opencode processes on one worktree don't clobber each other. Room history keeps the last 1000 messages; per-agent read positions survive trimming exactly.
- Commit `.agentchat/` or gitignore it, as you prefer.

## Install

opencode loads plugins once at startup — restart opencode after changes.

**Auto-discovered global plugin:**

```bash
git clone https://github.com/himanshugoel2797/opencode-agentchat \
  ~/.config/opencode/plugins/opencode-agentchat
```

**Or declare it in `opencode.json`:**

```jsonc
{
  "plugin": ["file:///absolute/path/to/opencode-agentchat/index.ts"]
}
```

(Once published to npm this becomes `"plugin": ["opencode-agentchat"]`.)

## Example flow

```
build (becomes "captain")
  chat_room_create(name: "refactor", purpose: "coordinate module split")
  chat_invite(room: "refactor", agents: ["backend-dev", "frontend-dev"])

be   (subagent "backend-dev")
  chat_room_list            # sees INVITED
  chat_room_join(room: "refactor")   # gets history
  chat_status(status: "implementing new API routes")

fe   (subagent "frontend-dev")
  chat_room_join(room: "refactor")
  chat_post(room: "refactor", message: "forms need name/email")

captain
  chat_read(room: "refactor")   # only the new message
  chat_agents                   # who is doing what, right now
```

## Development & maintenance

```bash
npm install
npx tsc --noEmit             # typecheck against the pinned plugin SDK
npx tsx test/smoke.ts        # tool-layer simulation (~1s)
npx tsx test/stress.ts       # 52 adversarial checks: races, liveness, corruption (~10s)
npx tsx test/e2e/e2e-live.ts # real `opencode serve` + mock LLM, two live sessions (~15s)
```

`docs/MAINTENANCE.md` is the maintenance manual: state schema, invariants,
tool contracts, and the exact opencode integration surface to re-verify on
every opencode upgrade (AGENTS.md points agents at it automatically).
