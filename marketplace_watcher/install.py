"""Install / uninstall / repair / doctor mechanics.

`run_install()` is the single source of truth — called by both the CLI
`install` and `repair` subcommands and the in-host `reinstall_native_host`
message handler.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path

from . import __version__
from .config import Config, config_dir, config_path, log_dir, log_path
from .logging_setup import helper_log, init_logging
from .protocol import EXTENSION_ID, MANIFEST_SCHEMA_VERSION, NATIVE_HOST_NAME

CLAUDE_INSTALL_HINT = (
    "Claude CLI not found on PATH. Install it from "
    "https://code.claude.com/docs/en/setup and re-run "
    "`marketplace-watcher install`."
)

HOST_SHIM_HINT = (
    "Could not locate the `marketplace-watcher-host` shim on PATH. The "
    "package was installed but the entry-point script is missing — most "
    "likely `uv tool install marketplace-watcher` was not the install path. "
    "If you ran `pip install` instead, ensure your scripts dir is on PATH."
)


@dataclass
class InstallResult:
    manifests_written: list[str]
    skipped_paths: list[str]
    claude_path: str
    host_shim_path: str


# --- Browser detection ----------------------------------------------------

def _home() -> Path:
    return Path.home()


def _posix_candidates() -> list[tuple[str, list[str], Path]]:
    """(browser_label, executable_candidates, native_host_manifest_dir)."""
    home = _home()
    return [
        ("stock-firefox-zen-shared", ["firefox", "zen-browser", "zen",
                                       "librewolf", "waterfox", "floorp"],
            home / ".mozilla" / "native-messaging-hosts"),
        ("snap-firefox", ["firefox"],
            home / "snap" / "firefox" / "common" / ".mozilla" /
            "native-messaging-hosts"),
        ("flatpak-firefox", [],
            home / ".var" / "app" / "org.mozilla.firefox" / ".mozilla" /
            "native-messaging-hosts"),
        ("flatpak-zen", [],
            home / ".var" / "app" / "app.zen_browser.zen" / ".zen" /
            "native-messaging-hosts"),
    ]


def _macos_native_host_dir() -> Path:
    return (_home() / "Library" / "Application Support" / "Mozilla" /
            "NativeMessagingHosts")


def _macos_candidates() -> list[tuple[str, list[str], Path]]:
    # All Gecko browsers on macOS read the same Mozilla NativeMessagingHosts
    # dir (verified for Firefox + Zen; LibreWolf/Waterfox/Floorp are Firefox
    # forks that honor it too). We list the fork executables for PATH-based
    # detection, but note that macOS .app bundles installed from a DMG rarely
    # put their binary on PATH — so detect_manifest_dirs() also force-writes
    # this dir on macOS regardless of detection (see the fallback there).
    return [
        ("macos-gecko-shared", ["firefox", "zen-browser", "zen",
                                 "librewolf", "waterfox", "floorp"],
            _macos_native_host_dir()),
    ]


def _is_flatpak_installed(app_id: str) -> bool:
    return shutil.which("flatpak") is not None and bool(
        _try(lambda: __import__("subprocess").run(
            ["flatpak", "info", app_id],
            capture_output=True, text=True, timeout=3,
        ).returncode == 0)
    )


def _try(fn):
    try:
        return fn()
    except Exception:
        return False


def detect_manifest_dirs() -> list[tuple[str, Path]]:
    """Return [(label, dir)] for every Gecko-browser native-host dir we
    should install to. Detection rules:

    - Executable on PATH OR the manifest dir already exists → install.
    - Flatpak browsers: install iff `flatpak info <app_id>` succeeds.
    - If nothing is detected, fall back to the stock Firefox path.
    """
    dirs: list[tuple[str, Path]] = []
    if sys.platform == "darwin":
        candidates = _macos_candidates()
    elif sys.platform == "win32":
        return []  # Windows uses the registry; see write_windows_registry()
    else:
        candidates = _posix_candidates()

    for label, exes, path in candidates:
        if label == "flatpak-firefox":
            if _is_flatpak_installed("org.mozilla.firefox") or path.exists():
                dirs.append((label, path))
            continue
        if label == "flatpak-zen":
            if _is_flatpak_installed("app.zen_browser.zen") or path.exists():
                dirs.append((label, path))
            continue
        if any(shutil.which(e) for e in exes) or path.exists():
            dirs.append((label, path))

    if not dirs:
        # Nothing detected. Fall back to the platform's stock Gecko native-host
        # dir so the manifest at least lands somewhere the browser reads.
        # CRITICAL: this must be platform-aware — macOS .app bundles from a DMG
        # don't put `firefox` on PATH and the NativeMessagingHosts dir may not
        # exist yet, so the macOS common case lands here. Writing the Linux
        # ~/.mozilla path on macOS would silently fail (Firefox never reads it).
        if sys.platform == "darwin":
            dirs.append(("fallback-macos-gecko", _macos_native_host_dir()))
        else:
            fallback = _home() / ".mozilla" / "native-messaging-hosts"
            dirs.append(("fallback-stock-firefox", fallback))

    return dirs


# --- Manifest content -----------------------------------------------------

def _build_manifest(host_shim_path: str) -> dict:
    # Keep this dict EXACTLY to Mozilla's NativeManifest schema — closed-shape
    # union of stdio/pkcs11/storage; any extra key (even one Mozilla "should"
    # tolerate) makes the whole manifest fail validation and the browser
    # reports "No such native application". The host's manifest-schema check
    # lives in config.json instead.
    return {
        "name": NATIVE_HOST_NAME,
        "description": "Marketplace Watcher native messaging host",
        "path": host_shim_path,
        "type": "stdio",
        "allowed_extensions": [EXTENSION_ID],
    }


def _write_manifest_json(target_dir: Path, body: dict) -> Path:
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / f"{NATIVE_HOST_NAME}.json"
    tmp = target.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(body, indent=2) + "\n")
    os.replace(tmp, target)
    return target


def _write_windows_registry(host_shim_path: str) -> str:
    """Returns the registry path written for reporting purposes."""
    if sys.platform != "win32":
        raise RuntimeError("Windows registry write attempted on non-Windows")

    import winreg  # type: ignore

    # The registry key references a JSON file on disk, not the executable
    # directly. So we still write the JSON manifest into the user's config
    # dir, then register its absolute path.
    manifest_dir = config_dir() / "native-host-manifests"
    manifest_dir.mkdir(parents=True, exist_ok=True)
    target = _write_manifest_json(manifest_dir, _build_manifest(host_shim_path))

    key_path = rf"Software\Mozilla\NativeMessagingHosts\{NATIVE_HOST_NAME}"
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key_path) as key:
        winreg.SetValueEx(key, "", 0, winreg.REG_SZ, str(target))
    return rf"HKCU\{key_path} -> {target}"


# --- Top-level install / uninstall / doctor -------------------------------

def _resolve_claude() -> str:
    path = shutil.which("claude")
    if not path:
        raise SystemExit(CLAUDE_INSTALL_HINT)
    return path


def _resolve_host_shim() -> str:
    # The pyproject [project.scripts] entry creates `marketplace-watcher-host`.
    # On Windows this is a .exe shim; shutil.which handles PATHEXT.
    path = shutil.which("marketplace-watcher-host")
    if path:
        return path
    raise SystemExit(HOST_SHIM_HINT)


def run_install() -> InstallResult:
    init_logging()
    claude_path = _resolve_claude()
    host_shim_path = _resolve_host_shim()
    manifest_body = _build_manifest(host_shim_path)

    written: list[str] = []
    skipped: list[str] = []

    if sys.platform == "win32":
        registry_target = _write_windows_registry(host_shim_path)
        written.append(registry_target)
    else:
        for label, target_dir in detect_manifest_dirs():
            try:
                target = _write_manifest_json(target_dir, manifest_body)
                written.append(str(target))
            except (PermissionError, OSError) as e:
                skipped.append(f"{label}: {target_dir} ({e})")

    config = Config(
        claude_path=claude_path,
        manifest_schema_version=MANIFEST_SCHEMA_VERSION,
        installed_manifests=written,
        host_version=__version__,
    )
    config.save()
    helper_log("install_complete", level="info",
               written=written, skipped=skipped,
               claude_path=claude_path, host_shim_path=host_shim_path)
    return InstallResult(
        manifests_written=written,
        skipped_paths=skipped,
        claude_path=claude_path,
        host_shim_path=host_shim_path,
    )


def run_uninstall() -> dict:
    init_logging()
    config = Config.load()
    removed: list[str] = []
    failed: list[str] = []

    if sys.platform == "win32":
        import winreg  # type: ignore
        key_path = rf"Software\Mozilla\NativeMessagingHosts\{NATIVE_HOST_NAME}"
        try:
            winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key_path)
            removed.append(rf"HKCU\{key_path}")
        except FileNotFoundError:
            pass
        except OSError as e:
            failed.append(f"HKCU registry key ({e})")
        manifest_dir = config_dir() / "native-host-manifests"
        for p in manifest_dir.glob(f"{NATIVE_HOST_NAME}.json"):
            try:
                p.unlink()
                removed.append(str(p))
            except OSError as e:
                failed.append(f"{p} ({e})")
    else:
        for path_str in config.installed_manifests:
            p = Path(path_str)
            try:
                if p.exists():
                    p.unlink()
                    removed.append(str(p))
            except OSError as e:
                failed.append(f"{p} ({e})")

    try:
        config_path().unlink()
    except FileNotFoundError:
        pass
    except OSError as e:
        failed.append(f"{config_path()} ({e})")

    return {"removed": removed, "failed": failed}


def run_doctor() -> dict:
    config = Config.load()
    claude_resolved = shutil.which("claude")
    claude_works = bool(claude_resolved)
    manifests_present: list[dict] = []

    if sys.platform == "win32":
        import winreg  # type: ignore
        key_path = rf"Software\Mozilla\NativeMessagingHosts\{NATIVE_HOST_NAME}"
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path) as key:
                json_path, _ = winreg.QueryValueEx(key, "")
                manifests_present.append({
                    "registry": rf"HKCU\{key_path}",
                    "manifest_file": json_path,
                    "manifest_file_exists": os.path.exists(json_path),
                })
        except FileNotFoundError:
            pass
    else:
        for path_str in config.installed_manifests:
            p = Path(path_str)
            manifests_present.append({
                "path": str(p),
                "exists": p.exists(),
            })

    lp = log_path()
    tail: list[str] = []
    if lp.exists():
        try:
            with open(lp, "r", encoding="utf-8") as f:
                tail = f.readlines()[-20:]
        except OSError:
            tail = []

    return {
        "host_version": __version__,
        "config_path": str(config_path()),
        "log_path": str(lp),
        "log_dir": str(log_dir()),
        "claude_resolved_path": claude_resolved,
        "claude_recorded_path": config.claude_path or None,
        "claude_paths_match": claude_resolved == (config.claude_path or None),
        "manifests": manifests_present,
        "manifest_schema_version": config.manifest_schema_version,
        "expected_manifest_schema_version": MANIFEST_SCHEMA_VERSION,
        "log_tail": [line.rstrip("\n") for line in tail],
    }
