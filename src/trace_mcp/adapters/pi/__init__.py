"""pi adapter.

Installs TRACE enforcement into the pi coding agent (https://pi.dev). pi has no
shell-hook layer; enforcement is one TypeScript extension that subscribes to
pi's lifecycle and tool events. The adapter installs:

1. ``extensions/trace-guard/index.ts`` (+ ``PI_BLOCK.md`` beside it) — session
   reminder, prompt nudge, pre-edit guard, decision audit, and the protocol
   block, which the extension appends to the system prompt while trace tools
   are loaded. pi has no "instructions" list, and an installer must not mutate
   the user's AGENTS.md, so the block travels with the extension.
2. the ``mcpServers.trace`` entry, merged into pi's ``mcp.json`` (Claude-style
   ``mcpServers`` shape, but pi's own file, with pi-only keys such as
   ``exposure``). ``owns_mcp_config = True`` so ``trace-mcp init`` skips its
   ``.mcp.json`` writer.

Targets:

* the pi agent directory (``~/.pi/agent``) for a global install — files go
  directly under it;
* any other directory is treated as a project — files go under ``<dir>/.pi/``
  (pi's project config directory; project resources load after trust).

The server entry pins ``TRACE_SESSIONS_DIR``, ``TRACE_REGISTRY_PATH`` and
``TRACE_KNOWLEDGE_DIR`` to absolute paths, and the extension reads those same
values from ``mcp.json`` — so the server and the guard cannot disagree about
where ``~`` is (per-sandbox ``HOME`` problem, SQ-2).
"""

from __future__ import annotations

import json
from pathlib import Path

from trace_mcp.adapters.base import Adapter, Disposition, InstallResult

_ASSETS = Path(__file__).parent / "assets"
_EXTENSION_SRC = _ASSETS / "extension" / "index.ts"
_BLOCK_SRC = _ASSETS / "PI_BLOCK.md"

MARKER_START = "<!-- trace-mcp:pi -->"
MARKER_END = "<!-- /trace-mcp:pi -->"

_EXT_DIR_REL = Path("extensions") / "trace-guard"

# Keys a user may tune on an installed entry; re-install keeps their values.
_PRESERVE_ENV = ("TRACE_GUARD", "TRACE_PROMPT_MIN_TURNS", "TRACE_PROMPT_COOLDOWN_SEC", "TRACE_PROJECT", "TRACE_REQUIRE_PIN")
_PRESERVE_KEYS = ("exposure", "toolExposure", "enabled", "timeout")


def is_agent_dir(directory: Path) -> bool:
    """True for pi's agent directory (``~/.pi/agent`` or a ``PI_CODING_AGENT_DIR``)."""
    if directory.name == "agent" and directory.parent.name == ".pi":
        return True
    return (directory / "auth.json").is_file() and (directory / "settings.json").is_file() and (directory / "sessions").is_dir()


def config_base(directory: Path) -> Path:
    """Where pi config lives for *directory*: the agent dir itself, or ``<project>/.pi``."""
    return directory if is_agent_dir(directory) else directory / ".pi"


def _repo_root() -> Path:
    return Path(__file__).resolve().parent.parent.parent.parent.parent


def trace_mcp_entry(home: Path | None = None) -> dict:
    """The ``mcpServers.trace`` entry for pi.

    Uses the console script in a venv beside the TRACE checkout when present
    (keep that checkout outside any sandbox that gets cleaned: venv shebangs are
    absolute), else a bare ``trace-mcp`` on PATH.
    """
    home = home or Path.home()
    venv_bin = _repo_root() / ".venv" / "bin" / "trace-mcp"
    trace_root = home / ".trace"
    return {
        "command": str(venv_bin) if venv_bin.exists() else "trace-mcp",
        "args": [],
        "env": {
            "TRACE_GUARD": "soft",
            "TRACE_SESSIONS_DIR": str(trace_root / "sessions"),
            "TRACE_REGISTRY_PATH": str(trace_root / "projects.json"),
            "TRACE_KNOWLEDGE_DIR": str(trace_root / "knowledge"),
            "TRACE_RUNTIME_DIR": str(trace_root / "runtime"),
            "TRACE_LLM_ENABLED": "false",
        },
        "description": "TRACE provenance: record decisions, contributions and corrections with attribution (who directed, who executed)",
        "exposure": "codemode",
        "timeout": 60,
    }


class PiAdapter(Adapter):
    """pi coding agent host integration."""

    name = "pi"
    owns_mcp_config = True
    pin_dir = ".pi"
    writes_rules_pin_line = False  # the block ships with the extension, AGENTS.md is untouched

    def detect(self, directory: Path) -> bool:
        return is_agent_dir(directory) or (directory / ".pi").is_dir()

    def install(self, directory: Path, *, dry_run: bool = False) -> list[InstallResult]:
        base = config_base(directory)
        return [
            _copy(_EXTENSION_SRC, base / _EXT_DIR_REL / "index.ts", dry_run=dry_run),
            _copy(_BLOCK_SRC, base / _EXT_DIR_REL / "PI_BLOCK.md", dry_run=dry_run),
            _merge_mcp(base / "mcp.json", dry_run=dry_run),
        ]

    def validate(self, directory: Path) -> list[str]:
        base = config_base(directory)
        errors: list[str] = []
        ext = base / _EXT_DIR_REL / "index.ts"
        blk = base / _EXT_DIR_REL / "PI_BLOCK.md"
        if not ext.is_file():
            errors.append(f"missing extension: {ext}")
        if not blk.is_file():
            errors.append(f"missing protocol block: {blk}")
        elif MARKER_START not in blk.read_text():
            errors.append(f"{blk} missing TRACE marker {MARKER_START}")
        mcp = base / "mcp.json"
        if not mcp.is_file():
            errors.append(f"missing {mcp}")
        else:
            try:
                data = json.loads(mcp.read_text())
            except json.JSONDecodeError as exc:
                errors.append(f"{mcp} is not valid JSON: {exc}")
            else:
                entry = (data.get("mcpServers") or {}).get("trace")
                if not isinstance(entry, dict):
                    errors.append(f"{mcp} has no 'mcpServers.trace' entry")
                else:
                    env = entry.get("env") or {}
                    for k in ("TRACE_SESSIONS_DIR", "TRACE_REGISTRY_PATH", "TRACE_KNOWLEDGE_DIR"):
                        v = env.get(k)
                        if not v or not Path(v).is_absolute():
                            errors.append(f"{mcp} trace env {k} must be an absolute path (got {v!r})")
        return errors


def _copy(src: Path, dst: Path, *, dry_run: bool) -> InstallResult:
    data = src.read_bytes()
    disposition: Disposition
    if not dst.exists():
        disposition = "installed"
    elif dst.read_bytes() != data:
        disposition = "updated"
    else:
        disposition = "skipped"
    if disposition != "skipped" and not dry_run:
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes(data)
    return InstallResult(path=dst, disposition=disposition)


def _merge_mcp(path: Path, *, dry_run: bool) -> InstallResult:
    """Merge ``mcpServers.trace`` into pi's mcp.json, keeping sibling servers and user-tuned keys."""
    existed = path.is_file()
    if existed:
        try:
            data = json.loads(path.read_text())
        except json.JSONDecodeError:
            return InstallResult(path=path, disposition="skipped", note="existing mcp.json is not valid JSON; left untouched")
        if not isinstance(data, dict):
            return InstallResult(path=path, disposition="skipped", note="mcp.json top level is not an object; left untouched")
    else:
        data = {}
    servers = data.setdefault("mcpServers", {})
    if not isinstance(servers, dict):
        return InstallResult(path=path, disposition="skipped", note="'mcpServers' is not an object; left untouched")

    desired = trace_mcp_entry()
    current = servers.get("trace")
    if isinstance(current, dict):
        for k in _PRESERVE_KEYS:
            if k in current:
                desired[k] = current[k]
        cur_env = current.get("env") or {}
        for k in _PRESERVE_ENV:
            if k in cur_env:
                desired["env"][k] = cur_env[k]
    if current == desired:
        return InstallResult(path=path, disposition="skipped")
    servers["trace"] = desired
    if not dry_run:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, indent=2) + "\n")
    return InstallResult(path=path, disposition="updated" if existed else "installed")


__all__ = ["PiAdapter", "MARKER_END", "MARKER_START", "config_base", "is_agent_dir", "trace_mcp_entry"]
