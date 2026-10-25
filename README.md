# pi-subagents-panes

Async subagents for [pi](https://github.com/badlogic/pi-mono), displayed as tabs or splits in
**Orca**, **herdr**, or **tmux**. Spawn a sub-agent, keep working in the main session, and get the
result steered back when it finishes. Fully non-blocking.

> Fork of [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents)
> (via [amosblomqvist's tmux fork](https://github.com/amosblomqvist/pi-interactive-subagents)).
> See [Acknowledgements](#acknowledgements) and [NOTICE.md](./NOTICE.md).

## How it works

`subagent()` returns immediately. The sub-agent runs in its own terminal surface — a tab, a split
to the right, or a split below the parent pi pane, depending on configuration. A live widget above
the input tracks every running sub-agent, and when one finishes, its result is steered into the
main session as a notification that triggers a new turn.

```
╭─ Subagents ──────────────────────────── 2 running ─╮
│ 00:23  scout      active · bash 7m                 │
│ 00:45  scout-2    waiting 2m                       │
╰────────────────────────────────────────────────────╯
```

Spawn several in parallel — they run concurrently and steer results back independently as each
finishes.

## Supported terminals

Detection is automatic, based on the environment pi was started in. You can force one with
`display.multiplexer`.

| Backend | Detected by | `tab` | `splitRight` | `splitDown` |
| ------- | ----------- | ----- | ------------ | ----------- |
| **Orca** | `ORCA_TERMINAL_HANDLE` + `orca` on PATH | `orca terminal create` | `orca terminal split --direction horizontal` | `orca terminal split --direction vertical` |
| **herdr** | `HERDR_PANE_ID` + `herdr` on PATH | `herdr tab create` | `herdr pane split --direction right` | `herdr pane split --direction down` |
| **tmux** | `TMUX` + `tmux` on PATH | `tmux new-window` | `split-window -h` | `split-window -v` |

Splits always target the calling pi's own pane, so nested subagents split themselves, never the
orchestrator's pane. New surfaces are created without stealing focus.

For tmux, panes stay evenly sized: the extension re-applies an `even-horizontal` layout after every
spawn and exit (debounced). Change `SUBAGENT_TMUX_LAYOUT` in
`pi-extension/subagents/surfaces/tmux.ts` to any named tmux layout (`main-vertical`, `tiled`, …).

If your shell startup is slow and launch commands get dropped before the prompt is ready, raise the
delay:

```bash
export PI_SUBAGENT_SHELL_READY_DELAY_MS=2500   # default: 500
```

## Configuration

Copy `config.json.example` to `config.json` in the extension directory (`config.json` is
gitignored):

```json
{
  "status": { "enabled": true },
  "display": {
    "mode": "splitRight",
    "nestedMode": "splitDown",
    "multiplexer": "auto"
  },
  "defaults": {},
  "models": {
    "exclude": ["*experimental*"],
    "tiers": { "cheap": ["*flash*:high"], "deep": ["anthropic/*sonnet*:max"] },
    "annotations": { "*flash*": "cheap recon; weak on large refactors" }
  },
  "architect": { "mode": "confirm", "maxAgents": 4, "maxDepth": 2 }
}
```

| Key | Values | Default | Meaning |
| --- | ------ | ------- | ------- |
| `display.mode` | `tab`, `splitRight`, `splitDown` | `splitRight` | Placement for subagents spawned by a top-level pi session |
| `display.nestedMode` | same | value of `mode` | Placement for subagents spawned **by another subagent** |
| `display.multiplexer` | `auto`, `orca`, `herdr`, `tmux` | `auto` | Force a backend instead of detecting |
| `status.enabled` | boolean | `true` | Show the running-subagents widget |
| `defaults.model` | model selector (`provider/id`) | inherit parent | Model for agents that do not set `model:` |
| `defaults.thinking` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` | inherit parent | Thinking level for agents that do not set `thinking:` |
| `models.exclude` | glob selectors (`*experimental*`) | none | Models never offered by the `models` tool |
| `models.tiers` | `{ name: [selector[:thinking], …] }` | none | Named shortlists the planner can filter by. An entry may pin a thinking level: `"*flash*:high"` |
| `models.annotations` | `{ selector: "note" }` | none | Your own judgement, shown next to the model |
| `architect.mode` | `plan`, `confirm`, `auto` | `confirm` | Whether the architect only plans, asks first, or executes |
| `architect.maxAgents` | integer, `0` = unlimited | `4` | Hard cap on subagents launched by one spawning run |
| `architect.maxDepth` | integer, `0` = unlimited | `2` | Hard cap on cascade depth |

A per-agent `display:` in frontmatter overrides both modes for that agent, at any depth.

### Model and thinking resolution

A subagent is a separate pi process, so nothing is inherited implicitly. Resolution runs
first-match-wins:

| | Order |
| --- | ----- |
| **Model** | `subagent({ model })` → agent `model:` → `defaults.model` → **the parent's current model** |
| **Thinking** | agent `thinking:` → `defaults.thinking` → the parent's current level |

The parent's thinking level is inherited only when the child also inherits the parent's model — a
different model may not support that level, so it falls back to the model's own default.

Because the parent's model is the last resort, switching model with `/model` in the parent changes
what every freshly spawned agent runs on. Pin a model in an agent's frontmatter (or in
`defaults.model`) when an agent should always use a specific one.

Changes are read at pi startup (and on `/reload`).

## Tools

| Tool | Description |
| --- | --- |
| `subagent` | Spawn a sub-agent in its own surface (async) |
| `subagent_message` | Message a sub-agent by name — steers it if running, resumes its session if finished |
| `subagents_list` | List available agent definitions |
| `models` | List models with cost, context window, thinking support and credentials — call before choosing a model |
| `ask_question` | *(sub-agent sessions only)* Ask the orchestrator a question and wait for the reply |

There is also a `/subagent <agent> <task>` command for spawning directly.

### Spawning

```typescript
subagent({ agent: "scout", task: "Analyze the auth module" });
subagent({ agent: "worker", name: "dark-mode", task: "Implement the dark mode toggle" });
```

| Parameter | Type | Default | Description |
| --------- | ---- | ------- | ----------- |
| `agent` | string | required | Which agent to spawn (must be known and permitted) |
| `task` | string | required | Task prompt |
| `name` | string | agent name | Display name for the surface and widget. Must be unique — duplicates are auto-suffixed (`scout`, `scout-2`, …) |
| `model` | string | agent's model | Override the model for this spawn |
| `cwd` | string | agent's `cwd` | Working directory (see [Role folders](#role-folders)) |

### Messaging

`subagent_message` is addressed **by name only**. Names are unique per session and persist after a
sub-agent finishes, so the same name works either way:

```typescript
subagent_message({ name: "scout", message: "Also check the auth middleware" });
```

- **Running** — the message is sent into the live surface (newlines flattened) and picked up at the
  next turn boundary. The call returns immediately; the eventual completion still arrives as a steer
  message.
- **Finished** — the session is resumed with the message as the follow-up task, like a fresh spawn:
  fire-and-forget, always autonomous, result steered back later. The resumed run reclaims its
  original name.

Every spawn records name → session file in `artifacts/<sessionId>/subagent-registry.json`, so names
stay addressable across pi restarts. A nested sub-agent that spawns children gets its own registry
keyed by its own session id. Resume is refused with a clear error (listing known names) if the name
isn't registered, the session file is gone, or the session predates sandboxed resume.

**Resume replays the original sandbox.** At spawn time the fully-resolved loadout — tool allowlist,
backing extensions, model, thinking level, system prompt, spawn whitelist, cwd, and display mode —
is snapshotted to `<session>.loadout.json`. Resume rebuilds the exact same restricted process from
that snapshot rather than relaunching unrestricted.

### ask_question

A sub-agent can ask its orchestrator a single freeform question when requirements are ambiguous or a
decision materially affects the work. The session **stays open** (parked as `waiting`) instead of
exiting; the parent is notified with the sub-agent's name, replies via
`subagent_message({ name, message })`, and the reply arrives as the sub-agent's next turn. Parallel
questions are supported — each waiting sub-agent has its own name.

If the reply arrives while the sub-agent is still mid-turn, it is absorbed into the current turn —
either way the question is marked answered and the session exits normally when the work is done. If
the parent never replies, the surface stays open until a human closes it. Only available inside
sub-agent sessions.

## Bundled agents

Every bundled agent inherits the parent's model and pins only a thinking level, so `/model` in the
parent propagates to all of them. Set `model:` in the frontmatter (or `defaults.model`) to pin one.

| Agent | Thinking | Tools | Role |
| ----- | -------- | ----- | ---- |
| **scout** | low | `read`, `grep`, `find`, `ls` | Fast read-only codebase recon |
| **researcher** | medium | `web_search`, `web_fetch`, `safe_bash` | Web research, synthesized into a sourced brief |
| **worker** | high | `read`, `write`, `edit`, `bash`, `web_search`, `web_fetch` + spawning | General implementer; may spawn `scout` and `researcher` |
| **reviewer** | high | `read`, `grep`, `find`, `ls`, `bash` | Read-only code review: correctness, security, data loss, regressions |
| **debugger** | high | `read`, `grep`, `find`, `ls`, `bash`, `edit` | Reproduces a failure, narrows to the cause, proves a minimal fix |
| **tester** | medium | `read`, `write`, `edit`, `grep`, `find`, `ls`, `bash` | Writes focused tests and runs them to green |
| **scribe** | medium | `read`, `write`, `grep`, `find`, `ls`, `bash` | Documentation that matches the code |
| **architect** | high | `read`, `grep`, `find`, `ls`, `read_only_bash`, `models` + spawning | Read-only planner: classifies the work, then returns the agent fleet, models and thinking levels |

All of them are autonomous (`auto-exit: true`) and carry their identity in the system prompt
(`system-prompt: append`). `worker` may spawn `scout` and `researcher`; `architect` may spawn any of
them (see below).

## Architect

`subagent({ agent: "architect", task })` asks a planner to decide *how* the work runs: which agents,
in what order, which model each one gets, and which thinking level it runs at.

```typescript
subagent({ agent: "architect", task: "Add rate limiting to the public API" });
```

**It plans; it never implements.** The architect's toolset has no `write`/`edit`, and its shell is
`read_only_bash`, which rejects redirection, command substitution, chaining, `sed -i`,
`find -exec/-delete`, and every mutating git subcommand. So it cannot change the repository even in
`confirm`/`auto` mode — implementation is always a spawned agent's job. If you want the plan without
a run, set `architect.mode: "plan"`.

**The deliverable is the strategy.** Its final message ends with a table the caller can act on
without re-deriving anything:

```text
Agent      Model                     Thinking  Depends on  Task
scout      deepseek/deepseek-v4.1-flash  low       —           map token validation paths
worker     deepseek/deepseek-v4.1-flash  xhigh     1           apply the fix in returned files
reviewer   anthropic/claude-sonnet-5.5   high      2           check diff for regressions
```

plus copy-paste `subagent({ agent, model, task })` calls, the agent count with its justification,
and the remaining risks. It classifies complexity first and justifies every spawn in one line.

**Model data comes from pi, not from config.** `models` reads the live registry — cost per Mtok,
context window, supported thinking levels, credential status. Config only adds what pi cannot know:
`models.annotations` (your judgement), `models.tiers` (named shortlists), `models.exclude`
(models to hide). Annotations and tiers accept globs: `deepseek/*`, `*flash*`, `anthropic/*sonnet*`.

A tier entry may pin the thinking level the planner should use for it:

```json
"tiers": { "cheap": ["*flash*:high"], "allround": ["deepseek/*-1017:xhigh"], "deep": ["anthropic/*sonnet*:max"] }
```

The `models` tool shows these as `allround:xhigh`, and the architect passes `selector:xhigh` to
`subagent({ model })`. The suffix sets the child's thinking level, so the tier's level follows the
model automatically instead of relying on the agent's own `thinking:` default.

**Autonomy is configurable** via `architect.mode`:

| Mode | Behaviour |
| ---- | --------- |
| `plan` | Plans and stops. The spawning toolset is withdrawn, so it *cannot* spawn |
| `confirm` | Calls `ask_question` with the plan, waits for approval, then spawns |
| `auto` | Plans and spawns immediately |

**Caps are enforced in code, not requested in a prompt.** `architect.maxAgents` counts spawns per
spawning run (one process), `architect.maxDepth` refuses spawns past the cascade depth. Exceeding
either fails the spawn with an explanation, so a runaway plan cannot quietly fan out.

The cascade itself is emergent: each agent's `subagent_agents:` list decides who *it* may spawn, so
the shape is `architect → worker → scout`. With the default `maxDepth: 2`, an architect's direct
children may not spawn grandchildren.

## Custom agents

Place a `.md` file in `.pi/agents/` (project) or `~/.pi/agent/agents/` (global). Discovery
priority: **project > global > package-bundled** — a project-local file overrides a bundled agent
with the same name.

```markdown
---
name: my-agent
description: Does something specific
model: openrouter/z-ai/glm-5.3
thinking: medium
tools: read, edit, write, safe_bash, web_search
session-mode: lineage-only
auto-exit: true
display: tab
---

You are a specialized agent that does X...
```

### Frontmatter reference

| Field | Type | Description |
| ----- | ---- | ----------- |
| `name` | string | Agent name (used in `agent: "my-agent"`) |
| `description` | string | Shown in `subagents_list` |
| `model` | string | Model selector (`provider/id`). Omit to inherit from `defaults.model`, then the parent's current model |
| `thinking` | string | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Omit to inherit from `defaults.thinking`, then the parent's level |
| `tools` | string | Strict tool allowlist. Built-ins: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`. Extension-backed: `web_search`, `web_fetch`, `safe_bash`, `read_only_bash` (inspection-only shell), `video_extract`, `youtube_search`, `google_image_search`. Only the extensions backing the listed tools are loaded into the child |
| `subagent_agents` | string | Comma-separated agent names this agent may spawn. **Presence of this field grants the spawning toolset** (`subagent`, `subagent_message`, `subagents_list`) and restricts spawn targets to the list. Omit it and the agent cannot spawn at all |
| `skills` | string | Comma-separated skill names to auto-load |
| `session-mode` | string | `standalone` (default), `lineage-only`, or `fork` — see below |
| `system-prompt` | string | `append` or `replace`: pass the body as the child's `--append-system-prompt` / `--system-prompt`. Omit and the body is prepended to the task prompt instead |
| `auto-exit` | boolean | Auto-shutdown when the agent finishes (see below) |
| `interactive` | boolean | Whether stall/recovery transitions wake the parent (see below) |
| `display` | string | `tab`, `splitRight`, or `splitDown` — overrides the configured placement for this agent |
| `cwd` | string | Default working directory |
| `disable-model-invocation` | boolean | Hide from `subagents_list`; still spawnable by explicit name |
| `cli` | string | `claude` runs the agent via the Claude Code CLI instead of pi |

### session-mode

- `standalone` — fresh session, no lineage link to the caller (default)
- `lineage-only` — fresh session with `parentSession` linkage for discovery/fork UX, but no copied turns
- `fork` — child session seeded with the caller's conversation context

### auto-exit

With `auto-exit: true`, the session shuts down when the agent's turn ends — the agent just writes its
final message and stops (there is no "done" tool). The last assistant message becomes the summary
returned to the parent. Recommended for all autonomous agents.

Notes:

- **Manual input does not strand an auto-exit sub-agent.** If a human types into the surface, the
  session still closes once that turn completes normally — only an escape/abort leaves it open.
- **Auto-exit is suppressed while work is in flight:** the session parks as `waiting` instead of
  exiting when an `ask_question` is still unanswered, or when the agent's own child sub-agents are
  still running (a worker can stop after dispatching children and stays open until the last result
  returns).

### interactive

Controls whether `stalled`/`recovered` status transitions send a steer message to the parent session.
Defaults to the inverse of `auto-exit`: autonomous agents get stall pings; user-driven agents stay
quiet (the user is already working in that pane — the widget still updates). Set explicitly to
override.

## Tool access control

Access is **whitelist-only**. Every sub-agent process is launched with `--no-extensions` (extension
discovery disabled) and `--tools <allowlist>`; only the extensions backing the listed tools are
loaded back in explicitly. There is no default toolset and no deny-list — an agent gets exactly what
its frontmatter lists. The restriction survives resume via the loadout snapshot.

Spawns must name a known agent at **every** depth. A top-level session may spawn anything
discoverable; a sub-agent may only spawn the agents in its `subagent_agents` list (enforced via
`PI_SUBAGENT_ALLOWED`). There is no agentless spawn route, so a child can never escalate to a
full-toolset profile by omitting its agent.

Extensions can register additional tools for sub-agents at runtime via
`registerToolExtension(name, path)` on the `__pi_interactive_subagents` process global.

## Role folders

`cwd` starts a sub-agent in a directory with its own config, so role-specific setups (CLAUDE.md,
skills, extensions) apply:

```
project/
└── agents/
    ├── game-designer/   ← CLAUDE.md, .pi/…
    └── sre/             ← CLAUDE.md, .pi/…
```

```typescript
subagent({ agent: "worker", cwd: "agents/sre", task: "Review the deployment pipeline" });
```

Set a per-agent default with `cwd:` in frontmatter.

## Status widget

The widget tracks each sub-agent from a runtime activity snapshot written by the child: `starting`,
`active` (turn/provider/tool work), `waiting` (open for input or another stage), `stalled` (no valid
snapshot for too long), or `running` (fallback). Sub-agent sessions also show their own tools widget
— toggle it with `Ctrl+Alt+O`. Completion messages expand with `Ctrl+O`.

## Requirements

- [pi](https://github.com/badlogic/pi-mono) 1.4.x (`@earendil-works/pi-coding-agent`)
- One of: [Orca](https://orca.dev), [herdr](https://herdr.dev), [tmux](https://github.com/tmux/tmux)

```bash
tmux new -A -s pi 'pi'      # tmux
herdr                        # herdr, then run pi in a pane
# Orca: open a terminal tab and run pi
```

## Troubleshooting

**A sub-agent reports `Failed to resolve API key for provider … from shell command: …`.**
That message is not necessarily an auth failure. pi runs the provider's key helper (whatever
`apiKey: "!<command>"` names in your provider config) **inside the child**, and if the child's
terminal is closed while that command is still running, the kill is reported as "failed to
resolve": no output, non-zero exit, same message.

That happens when the parent exits while its sub-agents are still starting — `pi -p "…"` ends its turn
right after `subagent()` returns, and this extension closes the sub-agent surfaces on shutdown. Measured
directly: 4 concurrent spawns from parents that exit immediately → 4/4 helper calls killed mid-flight
and 4 failed children; the identical spawns from parents that stay alive → 4/4 succeed. Interactive
sessions are unaffected because the parent lives on.

**Nothing appears and the widget says no multiplexer is available.** `display.multiplexer` is forced
to a backend that is not installed, or pi was started outside all three. `muxSetupHint()` lists what
was detected.

**Launch commands are dropped on a slow shell.** Raise
`PI_SUBAGENT_SHELL_READY_DELAY_MS` (see above).

## Development

```bash
pnpm install
pnpm test                   # unit tests (no multiplexer needed)
pnpm run typecheck
pnpm run test:integration   # tmux integration tests; run inside tmux
```

## Acknowledgements

This project is a fork of [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents),
which originated the subagent architecture, the multi-multiplexer surface layer, and the status
widget; its supervision features were inspired by [RepoPrompt](https://repoprompt.com/). The tmux
fork by [amosblomqvist](https://github.com/amosblomqvist/pi-interactive-subagents) is the direct
parent of this repository. Orca and herdr backends, configurable display placement, and the pi 1.4
API migration are additions in this fork — see [NOTICE.md](./NOTICE.md).

## License

MIT — see [LICENSE](./LICENSE). Original copyright (c) 2026 HazAT.
