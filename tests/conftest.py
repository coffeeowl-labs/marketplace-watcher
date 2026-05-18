"""Shared pytest fixtures.

Isolates each test that touches the on-disk log / config from the user's
real ~/.local/state and ~/.config locations by redirecting platformdirs
to a tmp_path. Without this, running the test suite would write to (and
potentially clobber) a real install.
"""

from __future__ import annotations

import logging
from pathlib import Path

import pytest


@pytest.fixture
def isolated_dirs(tmp_path, monkeypatch):
    cfg = tmp_path / "config"
    log = tmp_path / "log"
    cfg.mkdir()
    log.mkdir()
    monkeypatch.setattr("platformdirs.user_config_dir", lambda *_, **__: str(cfg))
    monkeypatch.setattr("platformdirs.user_log_dir", lambda *_, **__: str(log))

    # logging_setup caches an initialized RotatingFileHandler at module level.
    # Reset that state so each test gets a fresh handler pointed at the new
    # tmp dir, and tear down the handler afterward so the file lock releases.
    import marketplace_watcher.logging_setup as ls
    monkeypatch.setattr(ls, "_initialized", False)
    monkeypatch.setattr(ls, "_dedup_seen", set())
    monkeypatch.setattr(ls, "_dedup_order", [])

    yield {"config": cfg, "log": log}

    root = logging.getLogger("marketplace_watcher")
    for h in list(root.handlers):
        try:
            h.close()
        except Exception:
            pass
        root.removeHandler(h)
