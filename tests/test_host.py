"""Host wire-format + envelope validation + verdict-size discipline.

These cover the protocol-spec invariants that, if they regressed, would
silently corrupt the Firefox-host conversation."""

from __future__ import annotations

import io
import json
import struct
from unittest.mock import MagicMock

import pytest

from marketplace_watcher import host as h
from marketplace_watcher.protocol import (
    ERR_INVALID_PAYLOAD,
    ERR_SCHEMA_MISMATCH,
    MAX_PROFILE_NAME_CHARS,
    MAX_PROFILE_PROMPT_CHARS,
    MAX_REASON_BYTES,
    MAX_VERDICT_BYTES,
    SCHEMA_VERSION,
)


# --- _clamp_verdict --------------------------------------------------------

def test_clamp_verdict_passes_small_unchanged():
    v = {"id": "1", "verdict": "good", "reason": "ok"}
    assert h._clamp_verdict(v) == v


def test_clamp_verdict_truncates_long_reason():
    big = "x" * (MAX_REASON_BYTES + 1000)
    v = {"id": "1", "verdict": "good", "reason": big}
    out = h._clamp_verdict(v)
    assert out["_reason_truncated"] is True
    assert len(out["reason"].encode("utf-8")) <= MAX_REASON_BYTES + 4  # ellipsis bytes
    assert out["id"] == "1"
    assert out["verdict"] == "good"


def test_clamp_verdict_replaces_on_total_overflow():
    # A verdict whose other fields push it over the cap even after reason is
    # truncated should be wholesale replaced by a placeholder.
    blown = {
        "id": "1",
        "verdict": "good",
        "reason": "ok",
        "garbage": "y" * (MAX_VERDICT_BYTES + 1000),
    }
    out = h._clamp_verdict(blown)
    assert out["_truncated"] is True
    assert out["reason"] == "<truncated>"
    assert out["id"] == "1"
    assert out["verdict"] == "good"
    # Final size must be under the cap.
    assert len(json.dumps(out).encode("utf-8")) <= MAX_VERDICT_BYTES


def test_clamp_verdict_handles_non_string_reason():
    v = {"id": "1", "verdict": "good", "reason": None}
    out = h._clamp_verdict(v)
    assert out["reason"] is None  # unchanged


# --- _validate_and_clamp_profile ------------------------------------------

def test_clamp_profile_absent_field_is_ok():
    item = {"id": "1", "title": "t"}
    assert h._validate_and_clamp_profile(item) is None
    # No flat keys added when no profile present.
    assert "profile_name" not in item
    assert "profile_prompt" not in item


def test_clamp_profile_valid_shape_flattens_in_place():
    item = {"id": "1", "profile": {"name": "Small MTB",
                                    "prompt": "must be full suspension"}}
    assert h._validate_and_clamp_profile(item) is None
    assert item["profile_name"] == "Small MTB"
    assert item["profile_prompt"] == "must be full suspension"


def test_clamp_profile_clamps_oversized_prompt():
    big = "x" * (MAX_PROFILE_PROMPT_CHARS + 5000)
    item = {"id": "1", "profile": {"name": "x", "prompt": big}}
    assert h._validate_and_clamp_profile(item) is None
    assert len(item["profile_prompt"]) == MAX_PROFILE_PROMPT_CHARS


def test_clamp_profile_clamps_oversized_name():
    big = "n" * (MAX_PROFILE_NAME_CHARS + 100)
    item = {"id": "1", "profile": {"name": big, "prompt": "p"}}
    assert h._validate_and_clamp_profile(item) is None
    assert len(item["profile_name"]) == MAX_PROFILE_NAME_CHARS


def test_clamp_profile_rejects_non_dict():
    item = {"id": "1", "profile": "not an object"}
    err = h._validate_and_clamp_profile(item)
    assert err is not None
    assert err["code"] == ERR_INVALID_PAYLOAD


def test_clamp_profile_rejects_non_string_name():
    item = {"id": "1", "profile": {"name": 42, "prompt": "p"}}
    err = h._validate_and_clamp_profile(item)
    assert err is not None
    assert err["code"] == ERR_INVALID_PAYLOAD


def test_clamp_profile_rejects_non_string_prompt():
    item = {"id": "1", "profile": {"name": "n", "prompt": None}}
    err = h._validate_and_clamp_profile(item)
    assert err is not None
    assert err["code"] == ERR_INVALID_PAYLOAD


def test_clamp_profile_rejects_missing_name():
    item = {"id": "1", "profile": {"prompt": "p"}}
    err = h._validate_and_clamp_profile(item)
    assert err is not None
    assert err["code"] == ERR_INVALID_PAYLOAD


def test_clamp_profile_rejects_missing_prompt():
    item = {"id": "1", "profile": {"name": "n"}}
    err = h._validate_and_clamp_profile(item)
    assert err is not None
    assert err["code"] == ERR_INVALID_PAYLOAD


# --- _validate_envelope ----------------------------------------------------

def test_validate_envelope_accepts_good_message():
    msg = {"type": "health", "schema_version": SCHEMA_VERSION, "request_id": "abc"}
    assert h._validate_envelope(msg) is None


def test_validate_envelope_rejects_wrong_schema():
    msg = {"type": "health", "schema_version": SCHEMA_VERSION + 99, "request_id": "abc"}
    err = h._validate_envelope(msg)
    assert err is not None
    assert err["code"] == ERR_SCHEMA_MISMATCH
    assert err["host_schema"] == SCHEMA_VERSION
    assert err["ext_schema"] == SCHEMA_VERSION + 99


def test_validate_envelope_rejects_missing_request_id():
    msg = {"type": "health", "schema_version": SCHEMA_VERSION}
    err = h._validate_envelope(msg)
    assert err is not None
    assert err["code"] == ERR_INVALID_PAYLOAD


def test_validate_envelope_rejects_non_string_request_id():
    msg = {"type": "health", "schema_version": SCHEMA_VERSION, "request_id": 42}
    err = h._validate_envelope(msg)
    assert err is not None
    assert err["code"] == ERR_INVALID_PAYLOAD


def test_validate_envelope_rejects_non_dict():
    err = h._validate_envelope("not a dict")
    assert err is not None
    assert err["code"] == ERR_INVALID_PAYLOAD


# --- _read_message length-prefix framing ----------------------------------

class _FakeStdin:
    """Stands in for sys.stdin in host._read_message — exposes a .read(n)
    that returns up to n bytes from an internal buffer."""

    def __init__(self, payload: bytes):
        self._buf = payload

    def read(self, n: int) -> bytes:
        chunk = self._buf[:n]
        self._buf = self._buf[n:]
        return chunk


def _encode(obj: dict) -> bytes:
    body = json.dumps(obj).encode("utf-8")
    return struct.pack("<I", len(body)) + body


def test_read_message_round_trips(monkeypatch):
    msg = {"type": "health", "schema_version": SCHEMA_VERSION, "request_id": "x"}
    monkeypatch.setattr(h.sys, "stdin", _FakeStdin(_encode(msg)))
    assert h._read_message() == msg


def test_read_message_returns_none_on_clean_eof(monkeypatch):
    monkeypatch.setattr(h.sys, "stdin", _FakeStdin(b""))
    assert h._read_message() is None


def test_read_message_exits_on_oversized_request(monkeypatch):
    # Length prefix claiming > 1 MiB.
    raw = struct.pack("<I", 2 * 1024 * 1024) + b"x"
    monkeypatch.setattr(h.sys, "stdin", _FakeStdin(raw))
    with pytest.raises(SystemExit):
        h._read_message()


def test_read_message_exits_on_truncated_prefix(monkeypatch):
    monkeypatch.setattr(h.sys, "stdin", _FakeStdin(b"\x01\x02"))  # only 2 bytes
    with pytest.raises(SystemExit):
        h._read_message()


def test_read_message_exits_on_truncated_payload(monkeypatch):
    # Claims 100 bytes but only 5 follow.
    raw = struct.pack("<I", 100) + b"short"
    monkeypatch.setattr(h.sys, "stdin", _FakeStdin(raw))
    with pytest.raises(SystemExit):
        h._read_message()


# --- _write_message --------------------------------------------------------

def test_write_message_length_prefixed():
    captured = io.BytesIO()
    captured.fileno = lambda: -1  # so the broken-pipe paths don't blow up
    h.sys.stdout = captured
    try:
        h._write_message({"hello": "world"})
        captured.seek(0)
        (length,) = struct.unpack("<I", captured.read(4))
        payload = captured.read(length)
        assert json.loads(payload.decode()) == {"hello": "world"}
    finally:
        h.sys.stdout = __import__("sys").stdout
