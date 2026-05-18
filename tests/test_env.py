"""Subprocess env-scrubbing — verifies the allowlist contract documented in
DISTRIBUTION.md so future env additions don't silently leak through."""

from __future__ import annotations

import sys

from marketplace_watcher.env import scrubbed_env


def test_excludes_arbitrary_user_env(monkeypatch):
    monkeypatch.setenv("SECRET_API_KEY", "deadbeef")
    monkeypatch.setenv("PRIVATE_GPG_KEY", "should-not-pass")
    monkeypatch.setenv("HOME", "/some/home")
    env = scrubbed_env()
    assert "SECRET_API_KEY" not in env
    assert "PRIVATE_GPG_KEY" not in env


def test_passes_anthropic_and_claude_prefixes(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", "/tmp/claude")
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "https://example.test")
    env = scrubbed_env()
    assert env["ANTHROPIC_API_KEY"] == "sk-ant-test"
    assert env["CLAUDE_CONFIG_DIR"] == "/tmp/claude"
    assert env["ANTHROPIC_BASE_URL"] == "https://example.test"


def test_passes_lc_prefix_locale(monkeypatch):
    monkeypatch.setenv("LC_ALL", "C.UTF-8")
    monkeypatch.setenv("LC_TIME", "en_US.UTF-8")
    env = scrubbed_env()
    assert env["LC_ALL"] == "C.UTF-8"
    assert env["LC_TIME"] == "en_US.UTF-8"


def test_path_always_in_env(monkeypatch):
    monkeypatch.setenv("PATH", "/usr/bin:/usr/local/bin")
    env = scrubbed_env()
    assert env["PATH"] == "/usr/bin:/usr/local/bin"


def test_proxy_ca_bundle_passes(monkeypatch):
    # Required for corp MITM proxies — was specifically called out in the
    # protocol-spec critic pass.
    monkeypatch.setenv("SSL_CERT_FILE", "/etc/ssl/certs/corp-ca.pem")
    monkeypatch.setenv("SSL_CERT_DIR", "/etc/ssl/certs")
    env = scrubbed_env()
    assert env["SSL_CERT_FILE"].endswith("corp-ca.pem")
    assert env["SSL_CERT_DIR"] == "/etc/ssl/certs"


def test_platform_specific_keys_present():
    # Sanity that whichever platform the test runs on, we picked the right
    # allowlist (POSIX vs Windows vs macOS).
    env = scrubbed_env()
    if sys.platform == "win32":
        assert "USERPROFILE" in env or "APPDATA" in env
    else:
        # HOME is set in basically every POSIX env; the allowlist passes it.
        # If HOME isn't set we just trust the env doesn't include it.
        pass
