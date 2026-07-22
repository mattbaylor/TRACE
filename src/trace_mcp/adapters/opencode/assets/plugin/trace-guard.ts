// trace-mcp:opencode — TRACE enforcement plugin.
//
// The OpenCode analogue of the four Claude Code hook scripts, collapsed into
// one plugin module. OpenCode has no shell-hook layer; a plugin subscribes to
// events and tool hooks directly.
//
//   session reminder   -> event: "session.created"
//   prompt nudge       -> event: prompt/message submission (rate-limited)
//   pre-edit guard      -> "tool.execute.before" (throws in strict mode)
//   decision audit      -> "tool.execute.after" on trace_end_session
//
// Behavior parity with the Claude hooks is intentional, including env vars:
//   TRACE_GUARD               off | soft | strict   (default soft)
//   TRACE_PROMPT_MIN_TURNS    default 3
//   TRACE_PROMPT_COOLDOWN_SEC default 300
//   TRACE_SESSIONS_DIR        default ~/.trace/sessions
//   TRACE_RUNTIME_DIR         default ~/.trace/runtime
//
// A guard must never crash the tool call it runs alongside: every hook is
// wrapped so that an unexpected error degrades to "no reminder", never a throw
// (except the deliberate strict-mode block).

import { homedir } from "node:os"
import { join } from "node:path"
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"

const HOME = homedir()
const SESSIONS_DIR = process.env.TRACE_SESSIONS_DIR || join(HOME, ".trace", "sessions")
const RUNTIME_DIR = process.env.TRACE_RUNTIME_DIR || join(HOME, ".trace", "runtime")
const GUARD_MODE = (process.env.TRACE_GUARD || "soft").toLowerCase()
const MIN_TURNS = parseInt(process.env.TRACE_PROMPT_MIN_TURNS || "3", 10)
const COOLDOWN_SEC = parseInt(process.env.TRACE_PROMPT_COOLDOWN_SEC || "300", 10)

const TAG = "[trace-plugin v0.1]"

// ── canonical project identity ───────────────────────────────────────────
// Mirrors the Python shared block (trace-project-detect v0.5): fold, collapse
// separators, strip to a filesystem-safe key. A plugin canonicalizes a label;
// it never resolves aliases.
function canonicalKey(label: string): string {
  let s = label.normalize("NFC").trim().toLowerCase()
  s = s.replace(/[\s/_]+/g, "-")
  s = s.replace(/[^\w.-]+/g, "-")
  s = s.replace(/\.{2,}/g, ".")
  s = s.replace(/-{2,}/g, "-")
  return s.replace(/^[.-]+|[.-]+$/g, "")
}

const PIN_LINE = /TRACE project name\*{0,2}\s*:\s*"([^"]+)"/

function detectProject(dir: string): string {
  // 1. .opencode/trace.project pin file
  const pin = join(dir, ".opencode", "trace.project")
  try {
    if (existsSync(pin)) {
      const key = canonicalKey(readFileSync(pin, "utf8").trim())
      if (key) return key
    }
  } catch {}
  // 2. AGENTS.md / CLAUDE.md pin line
  for (const md of ["AGENTS.md", "CLAUDE.md"]) {
    try {
      const p = join(dir, md)
      if (existsSync(p)) {
        const m = PIN_LINE.exec(readFileSync(p, "utf8"))
        if (m) {
          const key = canonicalKey(m[1])
          if (key) return key
        }
      }
    } catch {}
  }
  // 3. directory basename (git basename resolution omitted: the plugin has the
  //    worktree/directory from context and does not shell out).
  return canonicalKey(dir.split("/").filter(Boolean).pop() || "")
}

function sessionKey(data: any): string {
  const meta = data?.metadata || {}
  if (typeof meta.project_key === "string" && meta.project_key) return meta.project_key
  const label = meta.project
  return typeof label === "string" ? canonicalKey(label) : ""
}

function hasActiveSession(key: string): boolean {
  try {
    if (!existsSync(SESSIONS_DIR)) return false
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "")
    for (const name of readdirSync(SESSIONS_DIR)) {
      if (!name.startsWith(`trace_${today}_`) || !name.endsWith(".json")) continue
      try {
        const data = JSON.parse(readFileSync(join(SESSIONS_DIR, name), "utf8"))
        if (data?.status !== "active") continue
        if (sessionKey(data) === key) return true
      } catch {}
    }
  } catch {}
  return false
}

// ── prompt-nudge rate-limit state ────────────────────────────────────────
function statePath(key: string): string {
  return join(RUNTIME_DIR, `${key || "unknown"}.state.json`)
}

function loadState(key: string): any {
  try {
    const p = statePath(key)
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"))
  } catch {}
  return {}
}

function saveState(key: string, state: any): void {
  try {
    mkdirSync(RUNTIME_DIR, { recursive: true })
    writeFileSync(statePath(key), JSON.stringify(state, null, 2))
  } catch {}
}

// ── the plugin ───────────────────────────────────────────────────────────
export const TraceGuardPlugin = async ({ directory, worktree, client }: any) => {
  const projectDir: string = worktree || directory || process.cwd()

  async function toast(message: string): Promise<void> {
    // Prefer a visible toast; fall back to a structured log. Never throw.
    try {
      if (client?.tui?.showToast) {
        await client.tui.showToast({ body: { message, variant: "warning" } })
        return
      }
    } catch {}
    try {
      await client?.app?.log?.({
        body: { service: "trace-guard", level: "warn", message },
      })
    } catch {}
  }

  return {
    event: async ({ event }: any) => {
      try {
        // session reminder — analogue of session-reminder.sh
        if (event?.type === "session.created") {
          const key = detectProject(projectDir)
          if (!hasActiveSession(key)) {
            const name = key || "this project"
            await toast(
              `TRACE MCP is available but no active session exists for project '${name}'. ` +
                `Start one with trace_start_session before logging events. ${TAG}`,
            )
          }
          return
        }

        // prompt nudge — analogue of prompt-reminder.sh. OpenCode's exact
        // prompt-submit event name may vary across versions; match on the
        // common shapes without hard-failing if none match.
        const t = event?.type || ""
        const isPromptSubmit =
          t === "message.updated" || t === "tui.prompt.append" || t === "session.status"
        if (isPromptSubmit) {
          const key = detectProject(projectDir)
          if (hasActiveSession(key)) {
            saveState(key, { turn_count: 0, last_nudged: null })
            return
          }
          const now = Date.now()
          const state = loadState(key)
          const turnCount = (parseInt(state.turn_count, 10) || 0) + 1
          let cooldownExpired = true
          if (state.last_nudged) {
            const last = Date.parse(state.last_nudged)
            if (!Number.isNaN(last)) {
              cooldownExpired = (now - last) / 1000 >= COOLDOWN_SEC
            }
          }
          if (turnCount >= MIN_TURNS && cooldownExpired) {
            saveState(key, { turn_count: turnCount, last_nudged: new Date().toISOString() })
            const name = key || "this project"
            await toast(
              `TRACE: you've been working in '${name}' for several turns without an active ` +
                `session. Call trace_start_session now so this work is part of the audit record. ${TAG}`,
            )
          } else {
            state.turn_count = turnCount
            saveState(key, state)
          }
        }
      } catch {
        // never let a reminder crash the session
      }
    },

    "tool.execute.before": async (input: any, _output: any) => {
      // pre-edit guard — analogue of pretool-guard.sh
      if (GUARD_MODE === "off") return
      const tool = input?.tool || ""
      if (tool !== "edit" && tool !== "write") return
      let key = ""
      let active = false
      try {
        key = detectProject(projectDir)
        active = hasActiveSession(key)
      } catch {
        return // detection failure must not block edits
      }
      if (active) return
      const name = key || "this project"
      const message =
        `TRACE: editing files in '${name}' but no active session exists. ` +
        `Call trace_start_session so this edit is recorded in the audit trail. ${TAG}`
      if (GUARD_MODE === "strict") {
        throw new Error(message)
      }
      await toast(message)
    },

    "tool.execute.after": async (input: any, output: any) => {
      // decision audit — analogue of decision-audit.sh
      try {
        const tool = input?.tool || ""
        if (tool !== "trace_end_session" && !tool.endsWith("trace_end_session")) return
        const key = detectProject(projectDir)
        const data = newestEndedForProject(key)
        if (!data) return
        const warnings = auditWarnings(data)
        if (warnings) {
          await toast(
            `TRACE Decision Audit: ${warnings}Review the Attribution Audit and fix any ` +
              `misattributions before closing. ${TAG}`,
          )
        }
      } catch {
        // audit is advisory; never throw
      }
    },
  }
}

// Select the newest session file belonging to this project (mirrors
// decision-audit.sh newest_for_project, simplified: newest by filename date
// then mtime is approximated by lexical filename order, which is date-then-id).
function newestEndedForProject(key: string): any | null {
  try {
    if (!existsSync(SESSIONS_DIR)) return null
    const files = readdirSync(SESSIONS_DIR)
      .filter((n) => n.startsWith("trace_") && n.endsWith(".json"))
      .sort()
      .reverse()
    for (const name of files) {
      try {
        const data = JSON.parse(readFileSync(join(SESSIONS_DIR, name), "utf8"))
        if (sessionKey(data) === key) return data
      } catch {}
    }
  } catch {}
  return null
}

const EXPLICIT_ABSENCE = new Set(["<autonomous-stretch>", "<no recent user message>"])

function isAbsence(s: any): boolean {
  return typeof s === "string" && EXPLICIT_ABSENCE.has(s.trim())
}

// Compute the same v0.4.1 audit metrics decision-audit.sh surfaces.
function auditWarnings(data: any): string {
  const events: any[] = data?.events || []
  const meta = data?.metadata || {}
  const actorTypes = new Set<string>()
  for (const p of meta.participants || []) {
    if (p?.type) actorTypes.add(p.type)
  }
  for (const e of events) {
    const at = e?.actor?.type
    if (at) actorTypes.add(at)
  }
  const multiActor = actorTypes.size >= 2

  let unresolved = 0
  let aiSelfResolved = 0
  let sameInstanceSelfResolved = 0
  let orphanCorrection = 0
  let missingSnippetContrib = 0
  let missingSnippetCorrection = 0

  for (const e of events) {
    const d = e?.decision
    const a = e?.annotation
    const c = e?.contribution
    const snip = e?.context?.conversation_snippet

    if (d) {
      if (d.disposition === "proposed") {
        unresolved++
      } else if (d.resolved_by) {
        const pb = d.proposed_by || {}
        const rb = d.resolved_by || {}
        if (pb.type === "ai" && rb.type === "ai") aiSelfResolved++
        if (multiActor && pb.type === rb.type && pb.id === rb.id) sameInstanceSelfResolved++
      }
    }
    if (a && a.category === "correction") {
      if (!a.corrects_event_ids || a.corrects_event_ids.length === 0) orphanCorrection++
      if (snip == null || (!isAbsence(snip) && !String(snip).trim())) missingSnippetCorrection++
    }
    if (c) {
      if (snip == null || (!isAbsence(snip) && !String(snip).trim())) missingSnippetContrib++
    }
  }

  const nonAiSelf = sameInstanceSelfResolved - aiSelfResolved
  let w = ""
  if (unresolved > 0) w += `${unresolved} unresolved decision(s). `
  if (aiSelfResolved > 0) w += `${aiSelfResolved} AI self-resolution(s). `
  if (nonAiSelf > 0) w += `${nonAiSelf} same-instance self-resolution(s) [spec §3.6]. `
  if (orphanCorrection > 0) w += `${orphanCorrection} orphaned correction(s). `
  if (missingSnippetContrib > 0)
    w += `${missingSnippetContrib} contribution(s) missing conversation_snippet [spec §3.4.1]. `
  if (missingSnippetCorrection > 0)
    w += `${missingSnippetCorrection} correction(s) missing conversation_snippet [spec §3.4.1]. `
  return w
}
