"""Adapter interface — the contract every host integration must satisfy."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

Disposition = Literal["installed", "updated", "skipped"]


@dataclass(frozen=True)
class InstallResult:
    """Record of a single file's installation outcome."""

    path: Path
    disposition: Disposition
    note: str = ""


class Adapter(ABC):
    """Install TRACE protocol enforcement into one host environment.

    Subclasses must set ``name`` and implement ``detect``, ``install``, and
    ``validate``. Adapters are pure installers — they do not run at MCP
    server time and must not be imported by ``server.py``.

    An adapter whose host uses a config format other than the Claude
    ``.mcp.json`` shape sets ``owns_mcp_config = True`` and writes the MCP
    server entry inside its own ``install``. ``trace-mcp init`` then skips its
    built-in ``.mcp.json`` writer for that adapter, so the two do not fight
    over where and how the server is registered.
    """

    name: str = ""
    owns_mcp_config: bool = False

    # Directory (relative to the project dir) where ``trace-mcp init`` writes
    # the ``trace.project`` identity pin the host's hooks/plugin read. Claude
    # Code uses ``.claude``; other hosts override.
    pin_dir: str = ".claude"

    # Whether ``trace-mcp init`` should also write a machine-parseable pin line
    # into the host's rules file (``CLAUDE.md``). Hosts whose rules file must
    # not be mutated by an installer set this False and carry identity another
    # way (e.g. a dedicated instructions file).
    writes_rules_pin_line: bool = True

    @abstractmethod
    def detect(self, directory: Path) -> bool:
        """Return True when this adapter's host is in use for *directory*."""

    @abstractmethod
    def install(self, directory: Path, *, dry_run: bool = False) -> list[InstallResult]:
        """Install hooks, config, and CLAUDE.md block into *directory*.

        Must be idempotent: re-running on an already-installed directory
        should produce ``skipped`` dispositions, not duplicate entries.

        When ``dry_run`` is True, compute the actions without writing files.
        """

    @abstractmethod
    def validate(self, directory: Path) -> list[str]:
        """Return a list of human-readable validation errors.

        Empty list means the adapter is correctly installed.
        """


__all__ = ["Adapter", "Disposition", "InstallResult"]
