"""Per-user paths and persisted install-time config.

Replaces the hardcoded `~/.local/state/marketplace_watcher` in the v0.1
helper. Uses platformdirs so paths Just Work on macOS/Windows too.
"""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field
from pathlib import Path

import platformdirs

from .protocol import MANIFEST_SCHEMA_VERSION

_APP_NAME = "marketplace-watcher"


def config_dir() -> Path:
    return Path(platformdirs.user_config_dir(_APP_NAME))


def log_dir() -> Path:
    return Path(platformdirs.user_log_dir(_APP_NAME))


def config_path() -> Path:
    return config_dir() / "config.json"


def log_path() -> Path:
    return log_dir() / "events.log"


@dataclass
class Config:
    """Install-time persisted state. Written by `install`, read by `host`."""

    claude_path: str = ""
    manifest_schema_version: int = MANIFEST_SCHEMA_VERSION
    installed_manifests: list[str] = field(default_factory=list)
    host_version: str = ""

    def save(self) -> None:
        path = config_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(asdict(self), indent=2) + "\n")
        os.replace(tmp, path)

    @classmethod
    def load(cls) -> "Config":
        path = config_path()
        if not path.exists():
            return cls()
        data = json.loads(path.read_text())
        known = {f for f in cls.__dataclass_fields__}
        return cls(**{k: v for k, v in data.items() if k in known})
