"""Subprocess-env scrubbing for the claude CLI invocation.

Defense-in-depth: don't leak the user's full environment into a child that
might later grow tool-use capable of exfiltrating env vars. Allowlist is
platform-conditional so we don't accidentally break Windows (no `HOME`, has
`USERPROFILE`; needs `PATHEXT` + `SYSTEMROOT` to launch `.cmd` shims).
"""

from __future__ import annotations

import os
import sys

_COMMON = {
    "PATH",
    "LANG",
    "TMPDIR",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_PATH",
    "NPM_CONFIG_PREFIX",
}
_COMMON_PREFIXES = ("ANTHROPIC_", "CLAUDE_", "LC_")

_POSIX = _COMMON | {"HOME", "USER", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"}
_MACOS = _POSIX | {"DYLD_FALLBACK_LIBRARY_PATH"}
_WINDOWS = _COMMON | {
    "USERPROFILE", "APPDATA", "LOCALAPPDATA",
    "SYSTEMROOT", "SYSTEMDRIVE", "COMSPEC", "PATHEXT",
    "TEMP", "TMP",
}


def _allowlist() -> set[str]:
    if sys.platform == "win32":
        return _WINDOWS
    if sys.platform == "darwin":
        return _MACOS
    return _POSIX


def scrubbed_env() -> dict[str, str]:
    keep = _allowlist()
    env = {k: v for k, v in os.environ.items() if k in keep}
    for k, v in os.environ.items():
        if k.startswith(_COMMON_PREFIXES):
            env[k] = v
    return env
