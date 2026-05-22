// Options page logic.
//
// - Loads cost params, address, debug toggle from chrome.storage.local
// - Opens a long-lived status port that polls health every 5 s; updates
//   the three status pills (helper / claude / last)
// - Save: writes cost_params + debug_logging directly; address goes
//   through background.saveUserLocation so geocoding happens against
//   the existing rate-limited fetch
// - Reinstall: opens a one-shot port; on success, status auto-refreshes

const $ = (id) => document.getElementById(id);

const els = {
  banner: $("first-run-banner"),
  address: $("home-address"),
  addressResolved: $("address-resolved"),
  hourly: $("hourly-rate"),
  gas: $("gas-price"),
  mpg: $("mpg"),
  saveBtn: $("save-btn"),
  saveStatus: $("save-status"),
  reinstallBtn: $("reinstall-btn"),
  reinstallStatus: $("reinstall-status"),
  logPath: $("log-path"),
  debug: $("debug-logging"),
  pillHelper: $("status-helper"),
  pillClaude: $("status-claude"),
  pillLast: $("status-last"),
};

const DEFAULTS = { hourly_rate: 20, gas_per_gallon: 5, mpg: 25 };

let statusPort = null;

async function loadInitial() {
  const data = await chrome.storage.local.get([
    "user_location", "cost_params", "debug_logging",
  ]);

  const loc = data.user_location;
  if (loc && loc.raw) {
    els.address.value = loc.raw;
    if (loc.display && loc.display !== loc.raw) {
      els.addressResolved.textContent = `Geocoded as: ${loc.display}`;
    }
    els.banner.hidden = true;
  } else {
    els.banner.hidden = false;
  }

  const cp = data.cost_params || {};
  els.hourly.value = Number.isFinite(cp.hourly_rate) ? cp.hourly_rate : DEFAULTS.hourly_rate;
  els.gas.value = Number.isFinite(cp.gas_per_gallon) ? cp.gas_per_gallon : DEFAULTS.gas_per_gallon;
  els.mpg.value = Number.isFinite(cp.mpg) ? cp.mpg : DEFAULTS.mpg;

  els.debug.checked = data.debug_logging === undefined ? true : !!data.debug_logging;
}

function parseField(input, fallback) {
  const v = parseFloat(input.value);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

async function saveAll() {
  els.saveStatus.textContent = "Saving…";
  els.saveStatus.className = "";
  els.saveBtn.disabled = true;
  try {
    const costParams = {
      hourly_rate: parseField(els.hourly, DEFAULTS.hourly_rate),
      gas_per_gallon: parseField(els.gas, DEFAULTS.gas_per_gallon),
      mpg: parseField(els.mpg, DEFAULTS.mpg),
    };
    await chrome.storage.local.set({
      cost_params: costParams,
      debug_logging: els.debug.checked,
    });

    const addressInput = els.address.value.trim();
    const stored = (await chrome.storage.local.get("user_location")).user_location;
    const storedRaw = stored && stored.raw ? stored.raw : "";
    if (addressInput !== storedRaw) {
      const resp = await chrome.runtime.sendMessage({
        type: "save_user_location", address: addressInput,
      });
      if (!resp || !resp.ok) {
        els.saveStatus.textContent = "Saved cost fields. Address: " +
          (resp && resp.error ? resp.error : "save failed");
        els.saveStatus.className = "err";
        return;
      }
      if (resp.location && resp.location.display) {
        els.addressResolved.textContent = `Geocoded as: ${resp.location.display}`;
      } else {
        els.addressResolved.textContent = "";
      }
      els.banner.hidden = !!addressInput;
    }

    els.saveStatus.textContent = "Saved.";
    els.saveStatus.className = "ok";
  } catch (e) {
    els.saveStatus.textContent = `Error: ${e.message}`;
    els.saveStatus.className = "err";
  } finally {
    els.saveBtn.disabled = false;
  }
}

function renderHealth(msg) {
  if (msg.error) {
    setPill(els.pillHelper, "helper", "disconnected", "err");
    setPill(els.pillClaude, "claude", "—", "pending");
    return;
  }
  setPill(els.pillHelper, "helper", "connected", "ok");

  const cli = msg.claude_cli || {};
  if (cli.status === "ok") {
    setPill(els.pillClaude, "claude", "ok", "ok");
  } else if (cli.status === "missing") {
    setPill(els.pillClaude, "claude", "missing", "err");
  } else {
    setPill(els.pillClaude, "claude", cli.status || "unknown", "warn");
  }

  if (msg.log_path) els.logPath.textContent = msg.log_path;
}

// The last-evaluation pill is sourced from chrome.storage.local, not the
// host's health response — the host process is short-lived (spawned per
// connectNative call) so any in-memory timestamp it tracks would always
// be gone before the next health poll. Background writes after every
// batch; we read on load and on storage changes.
async function refreshLastPill() {
  const data = await chrome.storage.local.get("last_evaluation");
  const le = data.last_evaluation || {};
  if (!le.ts_iso) {
    setPill(els.pillLast, "last", "never", "pending");
    return;
  }
  const when = formatAge(le.ts_iso);
  if (le.ok === true) {
    setPill(els.pillLast, "last", `${when} · ok`, "ok");
  } else if (le.ok === false) {
    const code = le.error && le.error.code ? le.error.code : "error";
    setPill(els.pillLast, "last", `${when} · ${code}`, "err");
  } else {
    setPill(els.pillLast, "last", when, "pending");
  }
}

function setPill(el, label, value, kind) {
  el.firstChild.textContent = `${label}: `;
  el.querySelector(".pill-val").textContent = value;
  el.classList.remove("pill-ok", "pill-warn", "pill-err", "pill-pending");
  el.classList.add(`pill-${kind}`);
}

function formatAge(iso) {
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return iso;
  const secs = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function openStatus() {
  if (statusPort) {
    try { statusPort.close(); } catch (_) {}
  }
  statusPort = openStatusPort({
    onHealthResult: renderHealth,
    onError: (msg) => {
      const text = msg.code === "schema_mismatch"
        ? (msg.host_schema > msg.ext_schema
            ? "Update the extension via AMO."
            : "Run `marketplace-watcher repair` (or use Advanced → Reinstall).")
        : (msg.message || msg.code);
      setPill(els.pillHelper, "helper", text, "err");
      setPill(els.pillClaude, "claude", "—", "pending");
      // last pill is independent of host state — leave it alone.
    },
    onDisconnect: () => {
      setPill(els.pillHelper, "helper", "disconnected", "err");
      setPill(els.pillClaude, "claude", "—", "pending");
      // last pill is independent of host state — leave it alone.
      setTimeout(() => { if (!document.hidden) openStatus(); }, 2000);
    },
  });
  statusPort.requestHealth();
}

let pollTimer = null;
function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    if (document.hidden) return;
    // Keep the "last" pill's "Xm ago" string ticking up even when no new
    // batch has run — formatAge derives from the storage timestamp.
    refreshLastPill().catch(() => {});
    if (!statusPort) return;
    try { statusPort.requestHealth(); } catch (_) { openStatus(); }
  }, 5000);
}
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

async function runReinstall() {
  els.reinstallStatus.textContent = "Reinstalling…";
  els.reinstallStatus.className = "";
  els.reinstallBtn.disabled = true;
  try {
    if (statusPort) { try { statusPort.close(); } catch (_) {} statusPort = null; }
    const result = await reinstallOneShot();
    if (result.error) {
      els.reinstallStatus.textContent = `Error: ${result.error.message || result.error.code}`;
      els.reinstallStatus.className = "err";
    } else {
      const n = (result.manifests_written || []).length;
      els.reinstallStatus.textContent =
        `Reinstalled (${n} manifest${n === 1 ? "" : "s"} written). Refreshing status…`;
      els.reinstallStatus.className = "ok";
      setTimeout(openStatus, 500);
    }
  } finally {
    els.reinstallBtn.disabled = false;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  loadInitial().catch((e) => console.error("[mw options] load failed:", e));
  refreshLastPill().catch((e) => console.error("[mw options] last pill load failed:", e));
  els.saveBtn.addEventListener("click", saveAll);
  els.reinstallBtn.addEventListener("click", runReinstall);
  els.address.addEventListener("input", () => {
    if (els.address.value.trim()) els.banner.hidden = true;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.last_evaluation) {
      refreshLastPill().catch(() => {});
    }
  });
  openStatus();
  startPolling();
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopPolling();
  } else {
    if (!statusPort) openStatus();
    startPolling();
  }
});

window.addEventListener("beforeunload", () => {
  if (statusPort) {
    try { statusPort.close(); } catch (_) {}
  }
});
