// Mirror of marketplace_watcher/protocol.py. Bump SCHEMA_VERSION only with a
// coordinated host change; mismatch sends a directional error reply that
// the options-page status row turns into an actionable message.

const SCHEMA_VERSION = 1;

const NATIVE_HOST_NAME = "marketplace_watcher";

// Message types — extension → host
const MSG_EVALUATE = "evaluate";
const MSG_HEALTH = "health";
const MSG_LOG_FLUSH = "log_flush";
const MSG_REINSTALL = "reinstall_native_host";

// Message types — host → extension
const MSG_VERDICT = "verdict";
const MSG_EVALUATE_DONE = "evaluate_done";
const MSG_HEALTH_RESULT = "health_result";
const MSG_REINSTALL_DONE = "reinstall_done";
const MSG_LOG_ACK = "log_ack";
const MSG_ERROR = "error";

// Per-batch lifecycle: extension waits this long after evaluate_done before
// calling port.disconnect(), so the host's final stdout write fully drains
// the kernel pipe buffer before SIGTERM arrives.
const DISCONNECT_GRACE_MS = 250;
