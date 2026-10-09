<!-- trace-mcp:pi -->

## TRACE Audit Protocol (v0.4.1+)

This environment uses [TRACE](https://github.com/Thru-Echoes/TRACE) for
transparent documentation of AI-human collaboration. The TRACE MCP server is
configured in pi's `mcp.json` under `mcpServers.trace` and enforced by the
`trace-guard` pi extension. Tools are named `mcp__trace__trace_<name>` and are
usually reached through `codemode`, e.g.
`await tools.mcp__trace__trace_start_session({ project: "ARTI-123", description: "..." })`.
Print only the ids and audit text you need.

**Absolute rule**: Never fabricate, falsify, or retroactively alter TRACE
data. A sparse honest record beats a dense fabricated one.

**Session lifecycle**

- **Start** a TRACE session at the beginning of any multi-step workflow with
  `mcp__trace__trace_start_session`.
- **End** with a summary via `mcp__trace__trace_end_session` when the workflow is
  complete. Review the Attribution Audit it returns before closing.

**What to log**

- **Decisions** (propose BEFORE acting, resolve when the human responds).
  - **Proposer Identity Rule (spec §3.6)**: set `proposed_by` to the actor who
    authored the proposal *content* (whose words populate `description`), not
    the speaker of the resolving directive. Question → AI-proposal → accept
    means `proposed_by=ai`, `resolved_by=human`.
- **Corrections** when a participant catches a mistake.
  - If the corrected entity is not a TRACE event (subagent output, tool
    result, external claim), use a URI-form reference per spec §3.7.1:
    `external:<uri>`, `jsonl:<path>#L<line>`, `subagent:<id>`, or
    `tool-result:<id>`.
- **Discoveries** (`category="discovery"`): non-trivial findings from
  autonomous work — log AT THE MOMENT of discovery, not in a post-hoc summary.
- **Contributions** — one per artifact, with `direction` (who had the idea)
  and `execution` (who did the work). Always set `conversation_snippet` to the
  relevant user message (~200 chars). If no user message motivated the event,
  use the explicit absence marker `<autonomous-stretch>` or
  `<no recent user message>` rather than omitting. Silent omission is a
  protocol violation per spec §3.4.1.
- **Subagent dispatches** when their outcome is summarized by a contribution —
  `mcp__trace__trace_log_tool_call(host="internal", server="pi", parent_event_id=...)`
  per spec §3.5. Skip routine file reads, greps, or TRACE's own calls.

Full protocol lives at the
[TRACE specification](https://github.com/Thru-Echoes/TRACE/blob/main/docs/specification.md).

<!-- /trace-mcp:pi -->
