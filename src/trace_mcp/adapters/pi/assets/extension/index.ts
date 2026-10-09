// trace-mcp:pi — TRACE enforcement extension for the pi coding agent.
//
// The pi analogue of the four Claude Code hook scripts (and of the OpenCode
// trace-guard plugin), in one extension:
//
//   session reminder  -> before_agent_start, first prompt of a session (message to the model)
//   prompt nudge      -> before_agent_start, rate-limited (message to the model)
//   pre-edit guard    -> tool_call on edit|write (strict: block; soft: warning appended to the result)
//   decision audit    -> tool_result on trace_end_session (warnings appended + UI notify)
//
// It also appends the TRACE protocol block (PI_BLOCK.md, next to this file) to
// the system prompt whenever trace tools are loaded, instead of mutating the
// user's AGENTS.md.
//
// Env vars match the Claude hooks and the OpenCode plugin:
//   TRACE_GUARD off|soft|strict (default soft), TRACE_PROMPT_MIN_TURNS (3),
//   TRACE_PROMPT_COOLDOWN_SEC (300), TRACE_SESSIONS_DIR, TRACE_RUNTIME_DIR.
// Resolution order: process env, then the `env` of the trace server entry in
// pi's mcp.json (so the server and this extension read ONE configured value —
// the "two ideas of ~" fix), then ~/.trace/... defaults.
//
// Project identity: a pi-phases ticket key (custom session entry "pi-phases"),
// then .pi/trace.project, then a "TRACE project name" pin line in AGENTS.md /
// CLAUDE.md, then the directory basename.
//
// Never let a reminder break a tool call: every hook degrades to "no reminder"
// on error, except the deliberate strict-mode block.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const TAG = "[trace-pi v0.1]";
const HOME = homedir();
const HERE = dirname(fileURLToPath(import.meta.url));

function readServerEntry(cwd: string): { env: Record<string, string>; configured: boolean } {
	const env: Record<string, string> = {};
	let configured = false;
	for (const file of [join(HOME, ".pi", "agent", "mcp.json"), join(cwd, ".pi", "mcp.json")]) {
		try {
			const entry = JSON.parse(readFileSync(file, "utf8"))?.mcpServers?.trace;
			if (!entry || typeof entry !== "object") continue;
			configured = entry.enabled !== false;
			if (entry.env && typeof entry.env === "object") Object.assign(env, entry.env);
		} catch {}
	}
	return { env, configured };
}

function expand(p: string): string {
	return p.startsWith("~/") ? join(HOME, p.slice(2)) : p;
}

interface Config {
	sessionsDir: string;
	runtimeDir: string;
	guard: string;
	minTurns: number;
	cooldownSec: number;
}

function config(cwd: string): Config {
	const server = readServerEntry(cwd).env;
	const get = (k: string, d: string) => process.env[k] || server[k] || d;
	return {
		sessionsDir: expand(get("TRACE_SESSIONS_DIR", join(HOME, ".trace", "sessions"))),
		runtimeDir: expand(get("TRACE_RUNTIME_DIR", join(HOME, ".trace", "runtime"))),
		guard: get("TRACE_GUARD", "soft").toLowerCase(),
		minTurns: parseInt(get("TRACE_PROMPT_MIN_TURNS", "3"), 10) || 3,
		cooldownSec: parseInt(get("TRACE_PROMPT_COOLDOWN_SEC", "300"), 10) || 300,
	};
}

// ── project identity (mirrors trace-project-detect v0.5) ───────────────────
export function canonicalKey(label: string): string {
	let s = label.normalize("NFC").trim().toLowerCase();
	s = s.replace(/[\s/_]+/g, "-");
	s = s.replace(/[^\w.-]+/g, "-");
	s = s.replace(/\.{2,}/g, ".");
	s = s.replace(/-{2,}/g, "-");
	return s.replace(/^[.-]+|[.-]+$/g, "");
}

const PIN_LINE = /TRACE project name\*{0,2}\s*:\s*"([^"]+)"/;

function phaseTicket(ctx: ExtensionContext): string | undefined {
	try {
		let key: string | undefined;
		for (const e of ctx.sessionManager.getBranch() as Array<{ type: string; customType?: string; data?: { type?: string; key?: string } }>) {
			if (e.type !== "custom" || e.customType !== "pi-phases") continue;
			if (e.data?.type === "start" && e.data.key) key = e.data.key;
			if (e.data?.type === "off") key = undefined;
		}
		return key;
	} catch {
		return undefined;
	}
}

export function detectProject(ctx: ExtensionContext): string {
	const ticket = phaseTicket(ctx);
	if (ticket) return canonicalKey(ticket);
	const dir = ctx.cwd;
	try {
		const pin = join(dir, ".pi", "trace.project");
		if (existsSync(pin)) {
			const key = canonicalKey(readFileSync(pin, "utf8").trim());
			if (key) return key;
		}
	} catch {}
	for (const md of ["AGENTS.md", "CLAUDE.md"]) {
		try {
			const p = join(dir, md);
			if (existsSync(p)) {
				const m = PIN_LINE.exec(readFileSync(p, "utf8"));
				if (m) {
					const key = canonicalKey(m[1]);
					if (key) return key;
				}
			}
		} catch {}
	}
	return canonicalKey(dir.split("/").filter(Boolean).pop() || "");
}

function sessionKey(data: any): string {
	const meta = data?.metadata || {};
	if (typeof meta.project_key === "string" && meta.project_key) return meta.project_key;
	return typeof meta.project === "string" ? canonicalKey(meta.project) : "";
}

// A ticket arc spans days, so unlike the Claude hooks this does not restrict to
// today's files; it scans sessions modified in the last 45 days instead.
const RECENT_MS = 45 * 24 * 3600 * 1000;
let activeCache: { key: string; at: number; value: boolean } | undefined;

function hasActiveSession(cfg: Config, key: string): boolean {
	if (activeCache && activeCache.key === key && Date.now() - activeCache.at < 5000) return activeCache.value;
	let value = false;
	try {
		if (existsSync(cfg.sessionsDir)) {
			const cutoff = Date.now() - RECENT_MS;
			for (const name of readdirSync(cfg.sessionsDir)) {
				if (!name.startsWith("trace_") || !name.endsWith(".json")) continue;
				const p = join(cfg.sessionsDir, name);
				try {
					if (statSync(p).mtimeMs < cutoff) continue;
					const data = JSON.parse(readFileSync(p, "utf8"));
					if (data?.status === "active" && sessionKey(data) === key) {
						value = true;
						break;
					}
				} catch {}
			}
		}
	} catch {}
	activeCache = { key, at: Date.now(), value };
	return value;
}

function newestForProject(cfg: Config, key: string): any | null {
	try {
		const files = readdirSync(cfg.sessionsDir)
			.filter((n) => n.startsWith("trace_") && n.endsWith(".json"))
			.map((n) => ({ n, m: statSync(join(cfg.sessionsDir, n)).mtimeMs }))
			.sort((a, b) => b.m - a.m);
		for (const { n } of files) {
			try {
				const data = JSON.parse(readFileSync(join(cfg.sessionsDir, n), "utf8"));
				if (sessionKey(data) === key) return data;
			} catch {}
		}
	} catch {}
	return null;
}

// ── nudge state (same file shape as the hooks/plugin) ──────────────────────
function statePath(cfg: Config, key: string) {
	return join(cfg.runtimeDir, `${key || "unknown"}.state.json`);
}
function loadState(cfg: Config, key: string): any {
	try {
		return JSON.parse(readFileSync(statePath(cfg, key), "utf8"));
	} catch {
		return {};
	}
}
function saveState(cfg: Config, key: string, state: any) {
	try {
		mkdirSync(cfg.runtimeDir, { recursive: true });
		writeFileSync(statePath(cfg, key), JSON.stringify(state, null, 2));
	} catch {}
}

// ── decision audit (v0.4.1 metrics, as decision-audit.sh) ──────────────────
const EXPLICIT_ABSENCE = new Set(["<autonomous-stretch>", "<no recent user message>"]);
const isAbsence = (s: any) => typeof s === "string" && EXPLICIT_ABSENCE.has(s.trim());

export function auditWarnings(data: any): string {
	const events: any[] = data?.events || [];
	const meta = data?.metadata || {};
	const actorTypes = new Set<string>();
	for (const p of meta.participants || []) if (p?.type) actorTypes.add(p.type);
	for (const e of events) if (e?.actor?.type) actorTypes.add(e.actor.type);
	const multiActor = actorTypes.size >= 2;
	let unresolved = 0, aiSelf = 0, sameInstance = 0, orphan = 0, missContrib = 0, missCorr = 0;
	for (const e of events) {
		const d = e?.decision, a = e?.annotation, c = e?.contribution;
		const snip = e?.context?.conversation_snippet;
		const missing = snip == null || (!isAbsence(snip) && !String(snip).trim());
		if (d) {
			if (d.disposition === "proposed") unresolved++;
			else if (d.resolved_by) {
				const pb = d.proposed_by || {}, rb = d.resolved_by || {};
				if (pb.type === "ai" && rb.type === "ai") aiSelf++;
				if (multiActor && pb.type === rb.type && pb.id === rb.id) sameInstance++;
			}
		}
		if (a && a.category === "correction") {
			if (!a.corrects_event_ids || a.corrects_event_ids.length === 0) orphan++;
			if (missing) missCorr++;
		}
		if (c && missing) missContrib++;
	}
	let w = "";
	if (unresolved) w += `${unresolved} unresolved decision(s). `;
	if (aiSelf) w += `${aiSelf} AI self-resolution(s). `;
	if (sameInstance - aiSelf > 0) w += `${sameInstance - aiSelf} same-instance self-resolution(s) [spec §3.6]. `;
	if (orphan) w += `${orphan} orphaned correction(s). `;
	if (missContrib) w += `${missContrib} contribution(s) missing conversation_snippet [spec §3.4.1]. `;
	if (missCorr) w += `${missCorr} correction(s) missing conversation_snippet [spec §3.4.1]. `;
	return w;
}

// ── the extension ──────────────────────────────────────────────────────────
export default function traceGuard(pi: ExtensionAPI) {
	let block: string | undefined;
	let remindedThisSession = false;
	const softWarned = new Map<string, string>();

	// codemode/deferred MCP servers connect in the background, so on the first turn the tools may not be
	// registered yet: an enabled trace entry in mcp.json counts as available too.
	let cwdForConfig = process.cwd();
	const traceLoaded = () => pi.getAllTools().some((t) => t.name.startsWith("mcp__trace__")) || readServerEntry(cwdForConfig).configured;
	const protocolBlock = () => {
		if (block === undefined) {
			try {
				block = readFileSync(join(HERE, "PI_BLOCK.md"), "utf8");
			} catch {
				block = "";
			}
		}
		return block;
	};

	pi.on("session_start", async (_e, ctx) => {
		cwdForConfig = ctx.cwd;
		remindedThisSession = false;
		softWarned.clear();
		activeCache = undefined;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		try {
			if (!traceLoaded()) return;
			const cfg = config(ctx.cwd);
			const key = detectProject(ctx);
			const name = key || "this project";
			const result: { systemPrompt?: string; message?: { customType: string; content: string; display: boolean } } = {};
			const b = protocolBlock();
			if (b) result.systemPrompt = `${event.systemPrompt}\n\n${b}`;

			if (hasActiveSession(cfg, key)) {
				saveState(cfg, key, { turn_count: 0, last_nudged: null });
				remindedThisSession = true;
				return result;
			}
			if (!remindedThisSession) {
				remindedThisSession = true;
				result.message = {
					customType: "trace-reminder",
					display: true,
					content: `TRACE MCP is available but no active session exists for project '${name}'. Start one with mcp__trace__trace_start_session before logging events. ${TAG}`,
				};
				return result;
			}
			const state = loadState(cfg, key);
			const turns = (parseInt(state.turn_count, 10) || 0) + 1;
			const last = state.last_nudged ? Date.parse(state.last_nudged) : NaN;
			const cooled = Number.isNaN(last) || (Date.now() - last) / 1000 >= cfg.cooldownSec;
			if (turns >= cfg.minTurns && cooled) {
				saveState(cfg, key, { turn_count: turns, last_nudged: new Date().toISOString() });
				result.message = {
					customType: "trace-reminder",
					display: true,
					content: `TRACE: you've been working in '${name}' for several turns without an active session. Call mcp__trace__trace_start_session now so this work is part of the audit record. ${TAG}`,
				};
			} else {
				saveState(cfg, key, { ...state, turn_count: turns });
			}
			return result;
		} catch {
			return;
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		let cfg: Config;
		let key: string;
		try {
			if (event.toolName !== "edit" && event.toolName !== "write") return;
			cfg = config(ctx.cwd);
			if (cfg.guard === "off" || !traceLoaded()) return;
			key = detectProject(ctx);
			if (hasActiveSession(cfg, key)) return;
		} catch {
			return; // detection failure must not block edits
		}
		const message = `TRACE: editing files in '${key || "this project"}' but no active session exists. Call mcp__trace__trace_start_session so this edit is recorded in the audit trail. ${TAG}`;
		if (cfg.guard === "strict") return { block: true, reason: message };
		softWarned.set(event.toolCallId, message);
		return;
	});

	pi.on("tool_result", async (event, ctx) => {
		try {
			const warn = softWarned.get(event.toolCallId);
			if (warn) {
				softWarned.delete(event.toolCallId);
				return { content: [...event.content, { type: "text", text: `\n${warn}` }], structuredContent: event.structuredContent };
			}
			if (!event.toolName.endsWith("trace_end_session")) return;
			const resultText = event.content.map((c: any) => (c?.type === "text" ? c.text : "")).join("");
			if (event.isError || /^\s*Error/i.test(resultText)) return;
			activeCache = undefined;
			const cfg = config(ctx.cwd);
			const data = newestForProject(cfg, detectProject(ctx));
			const warnings = data ? auditWarnings(data) : "";
			if (!warnings) return;
			const text = `TRACE Decision Audit: ${warnings}Review the Attribution Audit and fix any misattributions before closing. ${TAG}`;
			if (ctx.hasUI) ctx.ui.notify(text, "warning");
			return { content: [...event.content, { type: "text", text: `\n${text}` }], structuredContent: event.structuredContent };
		} catch {
			return;
		}
	});
}
