"""Native-messaging host: stdin/stdout JSON loop.

Entry point installed by pyproject.toml as the `marketplace-watcher-host`
console script. The native-host manifest's `path` points at this shim;
Firefox launches it on `browser.runtime.connectNative("marketplace_watcher")`.
"""

from __future__ import annotations

import json
import os
import signal
import struct
import sys
import threading
from typing import Optional

from . import __version__
from .claude_runner import CostParams, evaluate_parallel_streaming
from .config import Config, log_path
from .logging_setup import helper_log, init_logging, write_log_entries_deduped
from .protocol import (
    EXTENSION_ID,
    ERR_INTERNAL,
    ERR_INVALID_PAYLOAD,
    ERR_SCHEMA_MISMATCH,
    ERR_UNKNOWN_MESSAGE,
    MANIFEST_SCHEMA_VERSION,
    MAX_PROFILE_NAME_CHARS,
    MAX_PROFILE_PROMPT_CHARS,
    MAX_REASON_BYTES,
    MAX_VERDICT_BYTES,
    MSG_ERROR,
    MSG_EVALUATE,
    MSG_EVALUATE_DONE,
    MSG_HEALTH,
    MSG_HEALTH_RESULT,
    MSG_LOG_ACK,
    MSG_LOG_FLUSH,
    MSG_REINSTALL,
    MSG_REINSTALL_DONE,
    MSG_VERDICT,
    SCHEMA_VERSION,
)

_LEN_FMT = "<I"  # 4-byte little-endian unsigned (native-messaging spec)

_shutdown = threading.Event()


def _open_binary_stdio():
    """Make stdin/stdout binary + unbuffered. Length-prefix framing must not
    pass through text-mode line-ending munging or stdio block buffering.

    On Windows the underlying file descriptors default to text mode in the
    C runtime, and os.fdopen("rb"/"wb") wraps them in a Python-level binary
    object but does NOT change the FD's translation bit — every \\n written
    through fd 1 still gets expanded to \\r\\n on the wire, which corrupts
    the 4-byte length prefix and every JSON payload. msvcrt.setmode flips
    the FD itself to O_BINARY before we open it; this must run before any
    read or write touches fd 0 or 1.
    """
    if sys.platform == "win32":
        import msvcrt
        msvcrt.setmode(0, os.O_BINARY)
        msvcrt.setmode(1, os.O_BINARY)
    sys.stdin = os.fdopen(0, "rb", buffering=0)
    sys.stdout = os.fdopen(1, "wb", buffering=0)


def _read_exact(n: int) -> Optional[bytes]:
    buf = bytearray()
    while len(buf) < n:
        chunk = sys.stdin.read(n - len(buf))
        if not chunk:
            return None if not buf else bytes(buf)
        buf.extend(chunk)
    return bytes(buf)


def _read_message() -> Optional[dict]:
    raw_len = _read_exact(4)
    if raw_len is None:
        return None
    if len(raw_len) < 4:
        helper_log("stdin_eof_mid_prefix", level="error", got_bytes=len(raw_len))
        sys.exit(1)
    (length,) = struct.unpack(_LEN_FMT, raw_len)
    if length == 0:
        return {}
    if length > 1024 * 1024:
        helper_log("oversized_request", level="error", length=length)
        sys.exit(1)
    payload = _read_exact(length)
    if payload is None or len(payload) < length:
        helper_log("stdin_eof_mid_payload", level="error",
                   expected=length, got=len(payload) if payload else 0)
        sys.exit(1)
    try:
        return json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        helper_log("invalid_request_json", level="error", error=str(e))
        sys.exit(1)


def _write_message(obj: dict) -> None:
    encoded = json.dumps(obj, separators=(",", ":")).encode("utf-8")
    try:
        sys.stdout.write(struct.pack(_LEN_FMT, len(encoded)))
        sys.stdout.write(encoded)
    except BrokenPipeError:
        helper_log("stdout_broken_pipe", level="warn", msg_type=obj.get("type"))
        _shutdown.set()


def _clamp_verdict(v: dict) -> dict:
    reason = v.get("reason")
    if isinstance(reason, str):
        b = reason.encode("utf-8")
        if len(b) > MAX_REASON_BYTES:
            v = dict(v)
            v["reason"] = b[:MAX_REASON_BYTES].decode("utf-8", errors="ignore") + "…"
            v["_reason_truncated"] = True
    serialized = json.dumps(v, separators=(",", ":"))
    if len(serialized.encode("utf-8")) > MAX_VERDICT_BYTES:
        return {
            "id": v.get("id"),
            "verdict": v.get("verdict", "fair"),
            "reason": "<truncated>",
            "_truncated": True,
        }
    return v


def _validate_envelope(msg: dict, request_id_required: bool = True) -> Optional[dict]:
    if not isinstance(msg, dict):
        return {"code": ERR_INVALID_PAYLOAD, "message": "message not an object"}
    if msg.get("schema_version") != SCHEMA_VERSION:
        return {
            "code": ERR_SCHEMA_MISMATCH,
            "message": "schema_version mismatch",
            "host_schema": SCHEMA_VERSION,
            "ext_schema": msg.get("schema_version"),
        }
    if request_id_required and not isinstance(msg.get("request_id"), str):
        return {"code": ERR_INVALID_PAYLOAD, "message": "missing or non-string request_id"}
    return None


def _validate_and_clamp_profile(item: dict) -> Optional[dict]:
    """If a listing carries a `profile` field, validate and clamp it in
    place. Adds flat `profile_name` and `profile_prompt` keys (which
    build_user_prompt consumes) so downstream code doesn't have to drill
    into the nested object. Returns an error dict on malformed shape,
    None on valid OR absent (absent is normal — listings without a
    profile evaluate exactly as before).

    Defense in depth: this MUST run at the host boundary, not in
    build_user_prompt. A buggy extension shipping a 900 KB profile
    needs to be rejected here, before it reaches Claude's context.
    """
    prof = item.get("profile")
    if prof is None:
        return None
    if not isinstance(prof, dict):
        return {"code": ERR_INVALID_PAYLOAD,
                "message": "listing.profile must be an object"}
    name = prof.get("name")
    prompt = prof.get("prompt")
    if not isinstance(name, str) or not isinstance(prompt, str):
        return {"code": ERR_INVALID_PAYLOAD,
                "message": "listing.profile must have string name and prompt"}
    item["profile_name"] = name[:MAX_PROFILE_NAME_CHARS]
    item["profile_prompt"] = prompt[:MAX_PROFILE_PROMPT_CHARS]
    return None


def _send_error(req_id: Optional[str], err: dict) -> None:
    payload = {
        "type": MSG_ERROR,
        "schema_version": SCHEMA_VERSION,
        "request_id": req_id,
        **err,
    }
    _write_message(payload)


def _handle_evaluate(msg: dict, config: Config) -> None:
    req_id = msg["request_id"]
    listings = msg.get("listings")
    if not isinstance(listings, list) or not listings:
        _send_error(req_id, {"code": ERR_INVALID_PAYLOAD,
                             "message": "missing or empty listings"})
        return
    if len(listings) > 20:
        _send_error(req_id, {"code": ERR_INVALID_PAYLOAD,
                             "message": "max 20 listings per batch"})
        return
    for item in listings:
        if not isinstance(item, dict) or "id" not in item:
            _send_error(req_id, {"code": ERR_INVALID_PAYLOAD,
                                 "message": "each listing must have an id"})
            return
        perr = _validate_and_clamp_profile(item)
        if perr is not None:
            _send_error(req_id, perr)
            return

    cp_raw = msg.get("cost_params") or {}
    cost = CostParams(
        hourly_rate=float(cp_raw.get("hourly_rate", 20.0)),
        gas_per_gallon=float(cp_raw.get("gas_per_gallon", 5.0)),
        mpg=float(cp_raw.get("mpg", 25.0)),
    )

    if not config.claude_path:
        _send_error(req_id, {"code": "claude_missing",
                             "message": "claude path not configured; run `marketplace-watcher install`"})
        _write_message({
            "type": MSG_EVALUATE_DONE, "schema_version": SCHEMA_VERSION,
            "request_id": req_id,
            "error": {"code": "claude_missing",
                      "message": "claude path not configured"},
        })
        return

    seq_counter = [0]

    def on_verdict(v: dict) -> None:
        clamped = _clamp_verdict(v)
        _write_message({
            "type": MSG_VERDICT,
            "schema_version": SCHEMA_VERSION,
            "request_id": req_id,
            "verdict": clamped,
            "seq": seq_counter[0],
        })
        seq_counter[0] += 1

    def on_done(error: Optional[dict]) -> None:
        _write_message({
            "type": MSG_EVALUATE_DONE,
            "schema_version": SCHEMA_VERSION,
            "request_id": req_id,
            "error": error,
        })

    evaluate_parallel_streaming(listings, config.claude_path, cost,
                                on_verdict, on_done)


def _handle_health(msg: dict, config: Config) -> None:
    req_id = msg["request_id"]
    claude_status = "missing"
    claude_version = None
    if config.claude_path and os.path.exists(config.claude_path):
        claude_status = "ok"
    elif config.claude_path:
        claude_status = "missing"
    _write_message({
        "type": MSG_HEALTH_RESULT,
        "schema_version": SCHEMA_VERSION,
        "request_id": req_id,
        "claude_cli": {
            "status": claude_status,
            "path": config.claude_path or None,
            "version": claude_version,
        },
        "host_version": __version__,
        "schema_version_match": True,
        "manifest_schema_version": config.manifest_schema_version,
        "expected_manifest_schema": MANIFEST_SCHEMA_VERSION,
        "log_path": str(log_path()),
    })


def _handle_log_flush(msg: dict, wrote: int) -> None:
    _write_message({
        "type": MSG_LOG_ACK,
        "schema_version": SCHEMA_VERSION,
        "request_id": msg["request_id"],
        "wrote": wrote,
    })


def _handle_reinstall(msg: dict) -> None:
    req_id = msg["request_id"]
    from .install import run_install
    try:
        result = run_install()
        _write_message({
            "type": MSG_REINSTALL_DONE,
            "schema_version": SCHEMA_VERSION,
            "request_id": req_id,
            "error": None,
            "manifests_written": result.manifests_written,
            "claude_cli_path": result.claude_path,
            "restart_required": True,
        })
    except Exception as e:
        helper_log("reinstall_failed", level="error", error=str(e))
        _write_message({
            "type": MSG_REINSTALL_DONE,
            "schema_version": SCHEMA_VERSION,
            "request_id": req_id,
            "error": {"code": ERR_INTERNAL, "message": str(e)},
            "manifests_written": [],
            "claude_cli_path": None,
            "restart_required": True,
        })
    _shutdown.set()


def _dispatch(msg: dict, config: Config, logs_wrote: int) -> None:
    msg_type = msg.get("type")
    if msg_type == MSG_EVALUATE:
        _handle_evaluate(msg, config)
    elif msg_type == MSG_HEALTH:
        _handle_health(msg, config)
    elif msg_type == MSG_LOG_FLUSH:
        _handle_log_flush(msg, logs_wrote)
    elif msg_type == MSG_REINSTALL:
        _handle_reinstall(msg)
    else:
        _send_error(msg.get("request_id"), {
            "code": ERR_UNKNOWN_MESSAGE,
            "message": f"unknown message type: {msg_type!r}",
        })


def _on_sigterm(signum, frame):
    helper_log("sigterm_received", level="info")
    _shutdown.set()


def main() -> int:
    _open_binary_stdio()
    init_logging()
    signal.signal(signal.SIGTERM, _on_sigterm)
    if hasattr(signal, "SIGINT"):
        signal.signal(signal.SIGINT, _on_sigterm)

    config = Config.load()
    helper_log("host_start", level="info",
               version=__version__, claude_path=config.claude_path or None)

    try:
        while not _shutdown.is_set():
            msg = _read_message()
            if msg is None:
                helper_log("stdin_clean_eof", level="debug")
                break
            envelope_err = _validate_envelope(msg)
            if envelope_err is not None:
                _send_error(msg.get("request_id"), envelope_err)
                if envelope_err["code"] == ERR_SCHEMA_MISMATCH:
                    break
                continue
            # Drain piggybacked logs first so they're written in arrival order
            # even if the main handler streams responses concurrently later.
            logs_wrote = 0
            if msg.get("logs"):
                logs_wrote = write_log_entries_deduped(msg["logs"])
            try:
                _dispatch(msg, config, logs_wrote)
            except Exception as e:
                helper_log("dispatch_crash", level="error",
                           msg_type=msg.get("type"), error=str(e))
                _send_error(msg.get("request_id"),
                            {"code": ERR_INTERNAL, "message": str(e)})
    finally:
        try:
            sys.stdout.flush()
            try:
                os.fsync(sys.stdout.fileno())
            except (OSError, ValueError):
                pass
        except Exception:
            pass
        helper_log("host_exit", level="info")
    return 0


# Suppress unused-import warning for EXTENSION_ID — referenced indirectly via
# install.py when writing the native-host manifest.
_ = EXTENSION_ID
