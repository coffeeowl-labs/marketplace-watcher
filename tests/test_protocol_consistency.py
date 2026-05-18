"""Cross-language consistency check: the JS side mirrors the Python
constants. A drift between protocol.py and extension/protocol.js silently
corrupts the host/extension conversation (the schema-mismatch handler
only catches version skew, not constant drift)."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from marketplace_watcher import protocol as P

JS_PATH = Path(__file__).resolve().parent.parent / "extension" / "protocol.js"


@pytest.fixture(scope="module")
def js_constants() -> dict:
    src = JS_PATH.read_text()
    consts: dict = {}
    for m in re.finditer(r'const (\w+)\s*=\s*("[^"]*"|\d+)\s*;', src):
        raw = m.group(2)
        if raw.startswith('"'):
            consts[m.group(1)] = raw[1:-1]
        else:
            consts[m.group(1)] = int(raw)
    return consts


def test_schema_version_matches(js_constants):
    assert js_constants["SCHEMA_VERSION"] == P.SCHEMA_VERSION


def test_native_host_name_matches(js_constants):
    assert js_constants["NATIVE_HOST_NAME"] == P.NATIVE_HOST_NAME


@pytest.mark.parametrize("py_name,js_name", [
    ("MSG_EVALUATE", "MSG_EVALUATE"),
    ("MSG_HEALTH", "MSG_HEALTH"),
    ("MSG_LOG_FLUSH", "MSG_LOG_FLUSH"),
    ("MSG_REINSTALL", "MSG_REINSTALL"),
    ("MSG_VERDICT", "MSG_VERDICT"),
    ("MSG_EVALUATE_DONE", "MSG_EVALUATE_DONE"),
    ("MSG_HEALTH_RESULT", "MSG_HEALTH_RESULT"),
    ("MSG_REINSTALL_DONE", "MSG_REINSTALL_DONE"),
    ("MSG_LOG_ACK", "MSG_LOG_ACK"),
    ("MSG_ERROR", "MSG_ERROR"),
])
def test_message_type_constants_match(js_constants, py_name, js_name):
    py_val = getattr(P, py_name)
    js_val = js_constants[js_name]
    assert py_val == js_val, (
        f"Drift between Python {py_name}={py_val!r} and JS {js_name}={js_val!r}"
    )
