"""Log writer behaviour — focus on the (session_id, seq) dedup, since it's
the belt-and-suspenders against the extension retrying a flush after a
flaky disconnect."""

from __future__ import annotations

import json
from pathlib import Path

from marketplace_watcher.logging_setup import (
    helper_log,
    write_log_entries,
    write_log_entries_deduped,
)


def _read_log_lines(log_dir: Path) -> list[dict]:
    log = log_dir / "events.log"
    if not log.exists():
        return []
    return [json.loads(line) for line in log.read_text().splitlines() if line.strip()]


def test_write_log_entries_writes_unconditionally(isolated_dirs):
    n = write_log_entries([{"src": "a", "msg": "hi"}])
    assert n == 1
    assert _read_log_lines(isolated_dirs["log"])[0]["msg"] == "hi"


def test_deduped_writer_drops_repeat_session_id_seq_pair(isolated_dirs):
    e1 = {"src": "ext", "session_id": "S1", "seq": 1, "msg": "first"}
    e2 = {"src": "ext", "session_id": "S1", "seq": 2, "msg": "second"}
    n1 = write_log_entries_deduped([e1, e2])
    assert n1 == 2

    # Repeat the same pair — second call should write nothing.
    n2 = write_log_entries_deduped([e1, e2])
    assert n2 == 0

    lines = _read_log_lines(isolated_dirs["log"])
    msgs = [e["msg"] for e in lines]
    assert msgs == ["first", "second"]


def test_deduped_writer_keeps_entries_without_session_id(isolated_dirs):
    # Host-side entries from helper_log() have src=helper, no session_id —
    # those must always be written.
    e_helper = {"src": "helper", "category": "test", "level": "info"}
    n = write_log_entries_deduped([e_helper, e_helper])
    assert n == 2
    lines = _read_log_lines(isolated_dirs["log"])
    assert len(lines) == 2


def test_deduped_writer_distinguishes_sessions(isolated_dirs):
    e_s1 = {"src": "ext", "session_id": "S1", "seq": 1, "msg": "session1"}
    e_s2 = {"src": "ext", "session_id": "S2", "seq": 1, "msg": "session2"}
    n = write_log_entries_deduped([e_s1, e_s2])
    assert n == 2
    lines = _read_log_lines(isolated_dirs["log"])
    assert {e["msg"] for e in lines} == {"session1", "session2"}


def test_helper_log_routes_through_writer(isolated_dirs):
    helper_log("smoke", level="info", extra="payload")
    lines = _read_log_lines(isolated_dirs["log"])
    assert len(lines) == 1
    assert lines[0]["src"] == "helper"
    assert lines[0]["category"] == "smoke"
    assert lines[0]["extra"] == "payload"


def test_write_log_entries_survives_unserializable(isolated_dirs):
    class NotSerializable:
        pass

    # Has a circular reference + a non-default-serializable object. json.dumps
    # with default=str copes via repr; the writer should still produce a line.
    n = write_log_entries([{"src": "a", "weird": NotSerializable()}])
    assert n == 1
    lines = _read_log_lines(isolated_dirs["log"])
    assert len(lines) == 1
