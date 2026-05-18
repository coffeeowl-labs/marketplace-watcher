// Native-messaging wrapper for the marketplace-watcher host.
//
// Three port lifecycles (see DISTRIBUTION.md protocol spec):
//   - runEvaluateBatch:   one-shot port, streams verdict messages, sentinel
//   - checkHealthOneShot: one-shot port, single health round-trip
//   - flushLogsOneShot:   one-shot port, drains the log ring buffer
//   - openStatusPort:     long-lived port, used by the options page
//
// All callers go through this module — the only place that touches
// `browser.runtime.connectNative`.

function newRequestId() {
  return crypto.randomUUID();
}

function buildEnvelope(type, fields, logs) {
  const env = { type, schema_version: SCHEMA_VERSION, request_id: newRequestId(), ...fields };
  if (logs && logs.length) env.logs = logs;
  return env;
}

// Streamed evaluate: callbacks fire as verdict messages arrive. Resolves
// when the batch terminates (sentinel or disconnect), never rejects.
async function runEvaluateBatch({ listings, costParams, onVerdict, onError, piggybackLogs }) {
  return new Promise((resolve) => {
    let port;
    try {
      port = browser.runtime.connectNative(NATIVE_HOST_NAME);
    } catch (e) {
      onError({ code: "host_connect_failed", message: e.message || String(e) });
      resolve();
      return;
    }
    let settled = false;
    const reqId = newRequestId();

    const finalize = (err) => {
      if (settled) return;
      settled = true;
      if (err) onError(err);
      setTimeout(() => {
        try { port.disconnect(); } catch (_) {}
        resolve();
      }, DISCONNECT_GRACE_MS);
    };

    port.onMessage.addListener((msg) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.request_id !== reqId) return;
      if (msg.type === MSG_VERDICT) {
        try { onVerdict(msg.verdict, msg.seq); } catch (_) {}
      } else if (msg.type === MSG_EVALUATE_DONE) {
        finalize(msg.error || null);
      } else if (msg.type === MSG_ERROR) {
        finalize({
          code: msg.code,
          message: msg.message,
          host_schema: msg.host_schema,
          ext_schema: msg.ext_schema,
        });
      }
    });

    port.onDisconnect.addListener(() => {
      const err = port.error
        ? port.error.message || String(port.error)
        : "host disconnected unexpectedly";
      finalize({ code: "host_disconnect", message: err });
    });

    const envelope = {
      type: MSG_EVALUATE,
      schema_version: SCHEMA_VERSION,
      request_id: reqId,
      listings,
      cost_params: costParams,
    };
    if (piggybackLogs && piggybackLogs.length) envelope.logs = piggybackLogs;

    try {
      port.postMessage(envelope);
    } catch (e) {
      finalize({ code: "post_failed", message: e.message || String(e) });
    }
  });
}

// Resolves to either a health_result message or { error: {...} }. Never rejects.
async function checkHealthOneShot(piggybackLogs) {
  return new Promise((resolve) => {
    let port;
    try {
      port = browser.runtime.connectNative(NATIVE_HOST_NAME);
    } catch (e) {
      resolve({ error: { code: "host_connect_failed", message: e.message } });
      return;
    }
    let settled = false;
    const reqId = newRequestId();
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { port.disconnect(); } catch (_) {}
      resolve({ error: { code: "host_timeout", message: "health check timed out" } });
    }, 5000);

    port.onMessage.addListener((msg) => {
      if (!msg || msg.request_id !== reqId) return;
      if (msg.type === MSG_HEALTH_RESULT) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        setTimeout(() => { try { port.disconnect(); } catch (_) {} }, 100);
        resolve(msg);
      } else if (msg.type === MSG_ERROR) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { port.disconnect(); } catch (_) {}
        resolve({ error: { code: msg.code, message: msg.message,
                            host_schema: msg.host_schema, ext_schema: msg.ext_schema } });
      }
    });

    port.onDisconnect.addListener(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const err = port.error ? port.error.message : "host disconnect";
      resolve({ error: { code: "host_disconnect", message: err } });
    });

    const envelope = {
      type: MSG_HEALTH,
      schema_version: SCHEMA_VERSION,
      request_id: reqId,
    };
    if (piggybackLogs && piggybackLogs.length) envelope.logs = piggybackLogs;

    try {
      port.postMessage(envelope);
    } catch (e) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ error: { code: "post_failed", message: e.message } });
    }
  });
}

// Backstop drain: opens a port, sends logs, awaits ack, disconnects.
async function flushLogsOneShot(logs) {
  if (!logs || !logs.length) return { wrote: 0 };
  return new Promise((resolve) => {
    let port;
    try {
      port = browser.runtime.connectNative(NATIVE_HOST_NAME);
    } catch (e) {
      resolve({ wrote: 0, error: e.message });
      return;
    }
    let settled = false;
    const reqId = newRequestId();
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { port.disconnect(); } catch (_) {}
      resolve({ wrote: 0, timeout: true });
    }, 5000);

    port.onMessage.addListener((msg) => {
      if (!msg || msg.request_id !== reqId) return;
      if (msg.type === MSG_LOG_ACK) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { port.disconnect(); } catch (_) {}
        resolve({ wrote: msg.wrote || 0 });
      }
    });

    port.onDisconnect.addListener(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ wrote: 0, disconnected: true });
    });

    const envelope = {
      type: MSG_LOG_FLUSH,
      schema_version: SCHEMA_VERSION,
      request_id: reqId,
      logs,
    };
    try {
      port.postMessage(envelope);
    } catch (e) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ wrote: 0, error: e.message });
    }
  });
}

// Long-lived status port for the options page. Returns a Port-like wrapper
// that handles request/response matching and reconnection. Reserved for
// §5 options page; not used by background-side code today.
function openStatusPort({ onHealthResult, onError, onDisconnect }) {
  const port = browser.runtime.connectNative(NATIVE_HOST_NAME);
  port.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === MSG_HEALTH_RESULT && onHealthResult) onHealthResult(msg);
    else if (msg.type === MSG_ERROR && onError) onError(msg);
  });
  port.onDisconnect.addListener(() => {
    const err = port.error ? port.error.message : null;
    if (onDisconnect) onDisconnect(err);
  });
  return {
    requestHealth(piggybackLogs) {
      port.postMessage({
        type: MSG_HEALTH,
        schema_version: SCHEMA_VERSION,
        request_id: newRequestId(),
        ...(piggybackLogs && piggybackLogs.length ? { logs: piggybackLogs } : {}),
      });
    },
    close() {
      try { port.disconnect(); } catch (_) {}
    },
  };
}
