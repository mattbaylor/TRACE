"""OpenCode adapter.

Installs TRACE enforcement into an OpenCode environment. Unlike the Claude Code
adapter, OpenCode has no shell-hook layer: enforcement is a single TypeScript
plugin that subscribes to OpenCode's event/hook API. This adapter therefore
installs three things:

1. ``plugins/trace-guard.ts`` — the enforcement plugin (session reminder,
   prompt nudge, pre-edit guard, decision audit) in one module.
2. the ``mcp.trace`` server entry, merged into ``opencode.jsonc`` — OpenCode
   uses a ``mcp`` key with ``type: "local"`` and a ``command`` argv, which is a
   different shape from Claude's ``.mcp.json`` ``mcpServers``. Because of this
   the adapter sets ``owns_mcp_config = True`` and writes the entry itself;
   ``trace-mcp init`` skips its built-in ``.mcp.json`` writer.
3. ``instructions/trace.md`` — the protocol marker block, registered in
   ``opencode.jsonc``'s ``instructions`` array. Deliberately a dedicated file,
   NOT ``AGENTS.md``: an installer must not mutate the user's canonical rules
   file.

Install target is the directory passed to ``install`` — for a global install
run ``trace-mcp init`` from (or point it at) ``~/.config/opencode``.
"""

from __future__ import annotations

import json
from pathlib import Path

from trace_mcp.adapters.base import Adapter, Disposition, InstallResult

_ASSETS = Path(__file__).parent / "assets"
_PLUGIN_SRC = _ASSETS / "plugin" / "trace-guard.ts"
_BLOCK_SRC = _ASSETS / "OPENCODE_BLOCK.md"

MARKER_START = "<!-- trace-mcp:opencode -->"
MARKER_END = "<!-- /trace-mcp:opencode -->"

# Relative locations inside the OpenCode config directory.
_PLUGIN_REL = Path("plugins") / "trace-guard.ts"
_INSTRUCTIONS_REL = Path("instructions") / "trace.md"

# JSONC comment handling. OpenCode accepts JSON with comments; we tolerate a
# commented config on read by stripping comments before parsing, then re-emit
# plain JSON. A one-time comment loss on an existing config is noted to the
# user via the InstallResult, not done silently.
#
# Stripping must be string-aware: a naive `//` regex would corrupt every URL in
# a string value (e.g. "https://opencode.ai/config.json"). We walk the text
# tracking whether we are inside a JSON string, and only treat // and /* as
# comments outside strings.


def _strip_jsonc_comments(text: str) -> str:
    out: list[str] = []
    i = 0
    n = len(text)
    in_string = False
    while i < n:
        ch = text[i]
        if in_string:
            out.append(ch)
            if ch == "\\" and i + 1 < n:  # keep escaped char verbatim
                out.append(text[i + 1])
                i += 2
                continue
            if ch == '"':
                in_string = False
            i += 1
            continue
        # not in a string
        if ch == '"':
            in_string = True
            out.append(ch)
            i += 1
            continue
        if ch == "/" and i + 1 < n and text[i + 1] == "/":
            i += 2
            while i < n and text[i] != "\n":
                i += 1
            continue
        if ch == "/" and i + 1 < n and text[i + 1] == "*":
            i += 2
            while i + 1 < n and not (text[i] == "*" and text[i + 1] == "/"):
                i += 1
            i += 2
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def _has_jsonc_comments(text: str) -> bool:
    """True if stripping comments changes the text (string-aware)."""
    return _strip_jsonc_comments(text) != text


class OpenCodeAdapter(Adapter):
    """OpenCode host integration."""

    name = "opencode"
    owns_mcp_config = True
    pin_dir = ".opencode"
    writes_rules_pin_line = False  # identity lives in instructions/trace.md, not AGENTS.md

    def detect(self, directory: Path) -> bool:
        return (
            (directory / ".opencode").is_dir()
            or (directory / "opencode.json").is_file()
            or (directory / "opencode.jsonc").is_file()
        )

    def install(self, directory: Path, *, dry_run: bool = False) -> list[InstallResult]:
        results: list[InstallResult] = []
        results.append(_install_plugin(directory, dry_run=dry_run))
        results.append(_install_instructions(directory, dry_run=dry_run))
        results.append(_merge_config(directory, dry_run=dry_run))
        return results

    def validate(self, directory: Path) -> list[str]:
        errors: list[str] = []

        plugin = directory / _PLUGIN_REL
        if not plugin.is_file():
            errors.append(f"missing plugin: {plugin}")

        instructions = directory / _INSTRUCTIONS_REL
        if not instructions.is_file():
            errors.append(f"missing instructions file: {instructions}")
        elif MARKER_START not in instructions.read_text():
            errors.append(f"{instructions} missing TRACE marker {MARKER_START}")

        config_path = _find_config(directory)
        if config_path is None:
            errors.append(
                f"no opencode.json[c] found in {directory} "
                "(expected the adapter to have created one)"
            )
        else:
            try:
                data = _load_jsonc(config_path)
            except json.JSONDecodeError as exc:
                errors.append(f"{config_path} is not valid JSON(C): {exc}")
            else:
                mcp = data.get("mcp")
                if not isinstance(mcp, dict) or "trace" not in mcp:
                    errors.append(f"{config_path} has no 'mcp.trace' server entry")
                instr = data.get("instructions")
                rel = str(_INSTRUCTIONS_REL)
                if not isinstance(instr, list) or not any(
                    rel in str(p) for p in instr
                ):
                    errors.append(
                        f"{config_path} 'instructions' array does not reference {rel}"
                    )

        return errors


# ── config helpers ─────────────────────────────────────────────────────────


def _find_config(directory: Path) -> Path | None:
    """Return the existing opencode config file, preferring .jsonc, or None."""
    for name in ("opencode.jsonc", "opencode.json"):
        candidate = directory / name
        if candidate.is_file():
            return candidate
    return None


def _load_jsonc(path: Path) -> dict:
    """Parse a JSON or JSONC file into a dict (comments stripped, string-aware)."""
    raw = path.read_text()
    stripped = _strip_jsonc_comments(raw)
    data = json.loads(stripped)
    if not isinstance(data, dict):
        raise json.JSONDecodeError("top-level value is not an object", stripped, 0)
    return data


def _config_has_comments(path: Path) -> bool:
    return _has_jsonc_comments(path.read_text())


def _trace_mcp_entry(directory: Path) -> dict:
    """The ``mcp.trace`` entry for OpenCode.

    Points at the console entry point in a venv beside the TRACE source
    checkout (``<repo>/.venv/bin/trace-mcp``) when that venv exists; otherwise
    falls back to a bare ``trace-mcp`` on PATH. The command is an argv array,
    per OpenCode's local-server schema.
    """
    repo_root = Path(__file__).resolve().parent.parent.parent.parent.parent
    venv_bin = repo_root / ".venv" / "bin" / "trace-mcp"
    command = [str(venv_bin)] if venv_bin.exists() else ["trace-mcp"]
    return {
        "type": "local",
        "command": command,
        "enabled": True,
        "environment": {"TRACE_GUARD": "soft"},
    }


def _install_plugin(directory: Path, *, dry_run: bool) -> InstallResult:
    dst = directory / _PLUGIN_REL
    src_bytes = _PLUGIN_SRC.read_bytes()
    disposition: Disposition
    if not dst.exists():
        disposition = "installed"
    elif dst.read_bytes() != src_bytes:
        disposition = "updated"
    else:
        disposition = "skipped"
    if disposition != "skipped" and not dry_run:
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes(src_bytes)
    return InstallResult(path=dst, disposition=disposition)


def _install_instructions(directory: Path, *, dry_run: bool) -> InstallResult:
    dst = directory / _INSTRUCTIONS_REL
    block = _BLOCK_SRC.read_text()

    if dst.is_file():
        existing = dst.read_text()
        if MARKER_START in existing:
            return InstallResult(path=dst, disposition="skipped")
        if not dry_run:
            sep = "\n" if existing.endswith("\n") else "\n\n"
            dst.write_text(existing + sep + block)
        return InstallResult(path=dst, disposition="updated")

    if not dry_run:
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_text(block)
    return InstallResult(path=dst, disposition="installed")


def _merge_config(directory: Path, *, dry_run: bool) -> InstallResult:
    """Merge the mcp.trace entry and instructions reference into the config.

    Preserves sibling MCP servers and any existing config keys. If the target
    is a commented .jsonc, comments are lost on rewrite — surfaced in the
    result note rather than done silently.
    """
    existing_path = _find_config(directory)
    # Default to opencode.jsonc for a fresh write (matches the OpenCode default
    # and Matt's current global file).
    dst = existing_path or (directory / "opencode.jsonc")

    note = ""
    if existing_path is not None:
        try:
            data = _load_jsonc(existing_path)
        except json.JSONDecodeError:
            # Refuse to clobber an unparseable config — same posture as the
            # Claude adapter's settings merge, which fails safe.
            return InstallResult(
                path=dst,
                disposition="skipped",
                note="existing config is not valid JSON(C); left untouched",
            )
        if _config_has_comments(existing_path):
            note = "comments in existing .jsonc were stripped on rewrite"
    else:
        data = {"$schema": "https://opencode.ai/config.json"}

    changed = False

    mcp = data.setdefault("mcp", {})
    if not isinstance(mcp, dict):
        return InstallResult(
            path=dst, disposition="skipped", note="'mcp' key is not an object; left untouched"
        )
    desired_entry = _trace_mcp_entry(directory)
    if mcp.get("trace") != desired_entry:
        mcp["trace"] = desired_entry
        changed = True

    instructions = data.setdefault("instructions", [])
    rel = str(_INSTRUCTIONS_REL)
    if not isinstance(instructions, list):
        return InstallResult(
            path=dst,
            disposition="skipped",
            note="'instructions' key is not an array; left untouched",
        )
    if not any(rel in str(p) for p in instructions):
        instructions.append(rel)
        changed = True

    if not changed:
        return InstallResult(path=dst, disposition="skipped", note=note)

    disposition: Disposition = "updated" if existing_path is not None else "installed"
    if not dry_run:
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_text(json.dumps(data, indent=2) + "\n")
    return InstallResult(path=dst, disposition=disposition, note=note)


__all__ = ["OpenCodeAdapter", "MARKER_END", "MARKER_START"]
