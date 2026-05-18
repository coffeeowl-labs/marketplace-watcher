"""install.py: manifest content, config round-trip, browser-dir detection.

Detection is platform-conditional; the test fixtures monkey-patch
shutil.which and Path.exists to simulate environments other than the
host running the tests."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

from marketplace_watcher.config import Config
from marketplace_watcher.install import (
    _build_manifest,
    _write_manifest_json,
    detect_manifest_dirs,
    run_doctor,
)
from marketplace_watcher.protocol import EXTENSION_ID, MANIFEST_SCHEMA_VERSION, NATIVE_HOST_NAME


def test_build_manifest_structure():
    m = _build_manifest("/abs/path/to/host")
    assert m["name"] == NATIVE_HOST_NAME
    assert m["path"] == "/abs/path/to/host"
    assert m["type"] == "stdio"
    assert m["allowed_extensions"] == [EXTENSION_ID]
    assert m["manifest_schema_version"] == MANIFEST_SCHEMA_VERSION


def test_write_manifest_json_creates_parent_and_writes_valid_json(tmp_path):
    target_dir = tmp_path / "nested" / "dir"
    body = _build_manifest("/test/host")
    target = _write_manifest_json(target_dir, body)
    assert target.exists()
    assert target.name == f"{NATIVE_HOST_NAME}.json"
    loaded = json.loads(target.read_text())
    assert loaded == body


def test_config_round_trip(isolated_dirs):
    c = Config(
        claude_path="/test/bin/claude",
        manifest_schema_version=1,
        installed_manifests=["/a/path.json", "/b/path.json"],
        host_version="0.1.0",
    )
    c.save()
    loaded = Config.load()
    assert loaded.claude_path == "/test/bin/claude"
    assert loaded.manifest_schema_version == 1
    assert loaded.installed_manifests == ["/a/path.json", "/b/path.json"]
    assert loaded.host_version == "0.1.0"


def test_config_load_returns_defaults_when_file_missing(isolated_dirs):
    c = Config.load()
    assert c.claude_path == ""
    assert c.installed_manifests == []


def test_config_load_ignores_unknown_keys(isolated_dirs):
    from marketplace_watcher.config import config_path
    raw = {
        "claude_path": "/x/claude",
        "host_version": "9.9.9",
        "future_field_we_dont_know": "ignore me",
    }
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(raw))
    c = Config.load()
    assert c.claude_path == "/x/claude"
    assert c.host_version == "9.9.9"


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX detection only")
def test_detect_manifest_dirs_finds_stock_path_when_firefox_on_path(tmp_path, monkeypatch):
    # Force HOME so the candidate paths land in tmp.
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)

    def fake_which(name):
        return "/usr/bin/firefox" if name == "firefox" else None

    monkeypatch.setattr("shutil.which", fake_which)
    dirs = detect_manifest_dirs()
    labels = {label for label, _ in dirs}
    assert "stock-firefox-zen-shared" in labels


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX detection only")
def test_detect_manifest_dirs_fallback_when_no_browser_present(tmp_path, monkeypatch):
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)
    monkeypatch.setattr("shutil.which", lambda _name: None)
    dirs = detect_manifest_dirs()
    # Always falls back to writing stock-firefox path so the user has a
    # known location to investigate.
    labels = {label for label, _ in dirs}
    assert "fallback-stock-firefox" in labels


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX detection only")
def test_detect_manifest_dirs_skips_flatpak_when_app_not_installed(tmp_path, monkeypatch):
    monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)
    monkeypatch.setattr("shutil.which",
                        lambda name: "/usr/bin/firefox" if name == "firefox" else None)
    # is_flatpak_installed returns False for both apps in this env.
    monkeypatch.setattr("marketplace_watcher.install._is_flatpak_installed",
                        lambda _id: False)
    dirs = detect_manifest_dirs()
    labels = {label for label, _ in dirs}
    assert "flatpak-firefox" not in labels
    assert "flatpak-zen" not in labels


def test_run_doctor_reports_missing_config_cleanly(isolated_dirs, monkeypatch):
    # No prior install → doctor should still produce a structured report.
    monkeypatch.setattr("shutil.which", lambda _: None)
    report = run_doctor()
    assert report["host_version"] is not None
    assert report["claude_resolved_path"] is None
    assert report["claude_recorded_path"] is None
    assert report["manifests"] == []
