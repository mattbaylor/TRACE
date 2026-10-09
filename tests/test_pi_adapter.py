"""Tests for the pi adapter (installer side effects in temp dirs)."""

from __future__ import annotations

import json
from pathlib import Path

from trace_mcp.adapters import detect_adapter, get_adapter, list_adapters
from trace_mcp.adapters.pi import MARKER_START, PiAdapter, config_base, is_agent_dir


def _agent_dir(tmp_path: Path) -> Path:
    d = tmp_path / ".pi" / "agent"
    (d / "sessions").mkdir(parents=True)
    (d / "auth.json").write_text("{}")
    (d / "settings.json").write_text("{}")
    return d


class TestRegistryAndDetect:
    def test_registered(self) -> None:
        assert "pi" in list_adapters()
        assert isinstance(get_adapter("pi"), PiAdapter)

    def test_detects_agent_dir(self, tmp_path: Path) -> None:
        d = _agent_dir(tmp_path)
        assert is_agent_dir(d)
        a = detect_adapter(d)
        assert a is not None and a.name == "pi"

    def test_detects_project_with_dot_pi(self, tmp_path: Path) -> None:
        (tmp_path / ".pi").mkdir()
        assert PiAdapter().detect(tmp_path)

    def test_flags(self) -> None:
        a = PiAdapter()
        assert a.owns_mcp_config is True
        assert a.pin_dir == ".pi"
        assert a.writes_rules_pin_line is False


class TestInstall:
    def test_global_install_layout(self, tmp_path: Path) -> None:
        d = _agent_dir(tmp_path)
        results = PiAdapter().install(d)
        assert {r.disposition for r in results} == {"installed"}
        assert (d / "extensions" / "trace-guard" / "index.ts").is_file()
        block = (d / "extensions" / "trace-guard" / "PI_BLOCK.md").read_text()
        assert MARKER_START in block
        assert "mcp__trace__trace_start_session" in block
        entry = json.loads((d / "mcp.json").read_text())["mcpServers"]["trace"]
        for k in ("TRACE_SESSIONS_DIR", "TRACE_REGISTRY_PATH", "TRACE_KNOWLEDGE_DIR"):
            assert Path(entry["env"][k]).is_absolute()
        assert entry["env"]["TRACE_LLM_ENABLED"] == "false"
        assert PiAdapter().validate(d) == []

    def test_project_install_goes_under_dot_pi(self, tmp_path: Path) -> None:
        PiAdapter().install(tmp_path)
        assert config_base(tmp_path) == tmp_path / ".pi"
        assert (tmp_path / ".pi" / "extensions" / "trace-guard" / "index.ts").is_file()
        assert (tmp_path / ".pi" / "mcp.json").is_file()
        assert not (tmp_path / "AGENTS.md").exists()

    def test_idempotent(self, tmp_path: Path) -> None:
        d = _agent_dir(tmp_path)
        PiAdapter().install(d)
        assert {r.disposition for r in PiAdapter().install(d)} == {"skipped"}

    def test_preserves_siblings_and_user_tuning(self, tmp_path: Path) -> None:
        d = _agent_dir(tmp_path)
        (d / "mcp.json").write_text(
            json.dumps(
                {
                    "mcpServers": {
                        "atlassian": {"url": "https://mcp.atlassian.com/v1/mcp"},
                        "trace": {"command": "old", "env": {"TRACE_GUARD": "strict"}, "exposure": "direct"},
                    }
                }
            )
        )
        r = PiAdapter().install(d)[2]
        assert r.disposition == "updated"
        data = json.loads((d / "mcp.json").read_text())
        assert data["mcpServers"]["atlassian"]["url"].startswith("https://")
        t = data["mcpServers"]["trace"]
        assert t["env"]["TRACE_GUARD"] == "strict"
        assert t["exposure"] == "direct"
        assert t["command"] != "old"

    def test_invalid_mcp_json_left_untouched(self, tmp_path: Path) -> None:
        d = _agent_dir(tmp_path)
        (d / "mcp.json").write_text("{not json")
        r = PiAdapter().install(d)[2]
        assert r.disposition == "skipped"
        assert (d / "mcp.json").read_text() == "{not json"

    def test_dry_run_writes_nothing(self, tmp_path: Path) -> None:
        d = _agent_dir(tmp_path)
        results = PiAdapter().install(d, dry_run=True)
        assert all(r.disposition == "installed" for r in results)
        assert not (d / "mcp.json").exists()
        assert not (d / "extensions").exists()

    def test_validate_reports_missing(self, tmp_path: Path) -> None:
        d = _agent_dir(tmp_path)
        errs = PiAdapter().validate(d)
        assert any("missing extension" in e for e in errs)
        assert any("mcp.json" in e for e in errs)
