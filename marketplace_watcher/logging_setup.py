"""Rotating-file logger for host-side events.

§12 collapses the v0.1 dual-stream design (extension POSTs to /log; helper
writes events.jsonl) into a single chronological file. The extension's
piggybacked log entries land here through host_write_log_entries(); the
host's own structured events go through helper_log().
"""

from __future__ import annotations

import datetime
import json
import logging
import logging.handlers
import threading

from .config import log_dir, log_path

_lock = threading.Lock()
_initialized = False

LOG_MAX_BYTES = 10 * 1024 * 1024
LOG_BACKUP_COUNT = 2


def init_logging() -> None:
    global _initialized
    if _initialized:
        return
    log_dir().mkdir(parents=True, exist_ok=True)
    handler = logging.handlers.RotatingFileHandler(
        log_path(),
        maxBytes=LOG_MAX_BYTES,
        backupCount=LOG_BACKUP_COUNT,
        encoding="utf-8",
    )
    handler.setFormatter(logging.Formatter("%(message)s"))
    root = logging.getLogger("marketplace_watcher")
    root.setLevel(logging.DEBUG)
    root.addHandler(handler)
    _initialized = True


def _now_iso() -> str:
    return datetime.datetime.now().isoformat(timespec="milliseconds")


def _write_lines(entries: list[dict]) -> int:
    if not entries:
        return 0
    init_logging()
    root = logging.getLogger("marketplace_watcher")
    with _lock:
        for e in entries:
            if not isinstance(e, dict):
                e = {"raw": e}
            e.setdefault("ts_iso", _now_iso())
            try:
                line = json.dumps(e, default=str)
            except Exception as err:
                line = json.dumps({"ts_iso": _now_iso(), "log_error": str(err)})
            root.info(line)
    return len(entries)


def helper_log(category: str, *, level: str = "debug", **fields) -> None:
    entry = {"src": "helper", "category": category, "level": level, **fields}
    try:
        _write_lines([entry])
    except Exception:
        pass


def write_log_entries(entries: list[dict]) -> int:
    """Drain a piggybacked log batch from the extension."""
    return _write_lines(entries)


_dedup_seen: set[tuple[str, int]] = set()
_dedup_order: list[tuple[str, int]] = []
_DEDUP_CAP = 20_000


def write_log_entries_deduped(entries: list[dict]) -> int:
    """Dedupe by (session_id, seq) to absorb retried flushes from the
    extension. Entries without both keys are written unconditionally."""
    if not entries:
        return 0
    filtered: list[dict] = []
    with _lock:
        for e in entries:
            if not isinstance(e, dict):
                filtered.append(e)
                continue
            sid = e.get("session_id")
            seq = e.get("seq")
            if not isinstance(sid, str) or not isinstance(seq, int):
                filtered.append(e)
                continue
            key = (sid, seq)
            if key in _dedup_seen:
                continue
            _dedup_seen.add(key)
            _dedup_order.append(key)
            if len(_dedup_order) > _DEDUP_CAP:
                old = _dedup_order.pop(0)
                _dedup_seen.discard(old)
            filtered.append(e)
    return _write_lines(filtered)
