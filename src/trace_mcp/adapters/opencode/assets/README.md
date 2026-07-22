# OpenCode adapter

A working host adapter for [OpenCode](https://opencode.ai). Unlike the Codex
placeholder, OpenCode exposes a first-class plugin/event API, so this adapter
reaches full parity with the Claude Code adapter through a single TypeScript
plugin instead of four shell hooks.

## What it installs

`OpenCodeAdapter.install(directory)` writes three things into `directory` (for
a global install, that directory is `~/.config/opencode`):

| Artifact | Path | Analogue |
|---|---|---|
| Enforcement plugin | `plugins/trace-guard.ts` | the four `.claude/hooks/*.sh` scripts |
| MCP server entry | `mcp.trace` in `opencode.json[c]` | `.mcp.json` `mcpServers.trace` |
| Protocol marker | `instructions/trace.md` (+ registered in the `instructions` array) | the `CLAUDE.md` block |

## Why `owns_mcp_config = True`

`trace-mcp init` writes a Claude-shaped `.mcp.json` (`mcpServers`, `uvx`
command) before dispatching to the adapter. OpenCode uses a different shape:
the `mcp` key, `type: "local"`, and a `command` argv. The adapter therefore
sets `owns_mcp_config = True`; `init` skips its built-in `.mcp.json` writer and
lets the adapter merge the correct entry into `opencode.json[c]` itself. This
also avoids the wheel-install "fail closed" path, which is specific to the
uvx-source resolution the OpenCode adapter does not use.

## The plugin (`trace-guard.ts`)

One module, four behaviors, byte-for-byte behavioral parity with the Claude
hooks and the same env vars:

| Plugin hook | Behavior | Claude analogue |
|---|---|---|
| `event: session.created` | reminder when no active session | `session-reminder.sh` |
| prompt-submit event | rate-limited nudge | `prompt-reminder.sh` |
| `tool.execute.before` (edit/write) | warn (soft) or **throw to block** (strict) | `pretool-guard.sh` |
| `tool.execute.after` (trace_end_session) | Attribution Audit echo | `decision-audit.sh` |

Env vars: `TRACE_GUARD` (off/soft/strict), `TRACE_PROMPT_MIN_TURNS`,
`TRACE_PROMPT_COOLDOWN_SEC`, `TRACE_SESSIONS_DIR`, `TRACE_RUNTIME_DIR`.

A guard must never crash the tool call it runs alongside: every hook is wrapped
so an unexpected error degrades to "no reminder", never a throw — except the
deliberate strict-mode block.

## MCP command resolution

The `mcp.trace.command` points at `<repo>/.venv/bin/trace-mcp` when that venv
exists beside the TRACE source checkout, else a bare `trace-mcp` on PATH. This
matches the venv-launcher decision (no `uvx` dependency).

## Instructions file, not AGENTS.md

The marker goes in a dedicated `instructions/trace.md` registered in the
config's `instructions` array — never appended to `AGENTS.md`. An installer
must not mutate the user's canonical rules file.

## Install

```
trace-mcp init --client opencode           # into cwd
trace-mcp init --client opencode ~/.config/opencode   # global
trace-mcp init --client opencode --dry-run # preview
```
