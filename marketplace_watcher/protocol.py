"""Protocol constants shared between host and extension.

The extension mirrors these in extension/protocol.js. Bump SCHEMA_VERSION
only with a coordinated extension+host change; a mismatch sends an `error`
message with directional repair instructions (see DISTRIBUTION.md spec).
"""

SCHEMA_VERSION = 1

# Native host manifest (registry on Windows, JSON on POSIX). When this changes
# in a backwards-incompatible way, `marketplace-watcher repair` is required.
MANIFEST_SCHEMA_VERSION = 1

NATIVE_HOST_NAME = "marketplace_watcher"
EXTENSION_ID = "marketplace-watcher@coffeeowl-labs.github.io"

# Per-message caps to stay under Firefox's 1 MB native-message ceiling.
MAX_REASON_BYTES = 32 * 1024
MAX_VERDICT_BYTES = 256 * 1024

# Message types — extension → host
MSG_EVALUATE = "evaluate"
MSG_HEALTH = "health"
MSG_LOG_FLUSH = "log_flush"
MSG_REINSTALL = "reinstall_native_host"

# Message types — host → extension
MSG_VERDICT = "verdict"
MSG_EVALUATE_DONE = "evaluate_done"
MSG_HEALTH_RESULT = "health_result"
MSG_REINSTALL_DONE = "reinstall_done"
MSG_LOG_ACK = "log_ack"
MSG_ERROR = "error"

# Error codes inside an `evaluate_done.error` payload or a top-level `error`.
ERR_CLAUDE_MISSING = "claude_missing"
ERR_CLAUDE_FAILED = "claude_failed"
ERR_CLAUDE_TIMEOUT = "claude_timeout"
ERR_VERDICT_ID_MISMATCH = "verdict_id_mismatch"
ERR_INTERNAL = "internal_error"
ERR_SCHEMA_MISMATCH = "schema_mismatch"
ERR_UNKNOWN_MESSAGE = "unknown_message"
ERR_INVALID_PAYLOAD = "invalid_payload"
