# TRACE for pi

`trace-mcp init --client pi` (from a project, or pointed at `~/.pi/agent` for a global install) installs:

- `extensions/trace-guard/index.ts` + `PI_BLOCK.md` — the enforcement extension: session reminder and
  rate-limited nudge (as messages to the model), pre-edit guard on `edit`/`write`
  (`TRACE_GUARD=soft` appends a warning to the tool result, `strict` blocks), and the decision audit
  after `trace_end_session`. It appends the protocol block to the system prompt while trace tools are
  loaded, so `AGENTS.md` is never modified.
- `mcpServers.trace` in pi's `mcp.json`, with `TRACE_SESSIONS_DIR`, `TRACE_REGISTRY_PATH`,
  `TRACE_KNOWLEDGE_DIR` and `TRACE_RUNTIME_DIR` pinned to absolute paths. The extension reads the same
  values from `mcp.json`, so server and guard always agree on the store location. Exposure defaults to
  `codemode` (call `tools.mcp__trace__trace_*` from scripts).

Project identity for the guard: a pi-phases ticket key when a phase is active, then `.pi/trace.project`,
then a `TRACE project name: "…"` line in `AGENTS.md`/`CLAUDE.md`, then the directory basename.

Global install without enrolling a project or writing a pin file:

    .venv/bin/python -c "from pathlib import Path; from trace_mcp.adapters.pi import PiAdapter; \
      [print(r) for r in PiAdapter().install(Path.home()/'.pi/agent')]"

Then `/reload` in pi.
