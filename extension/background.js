// background.js — orchestrates scraping + evaluation
//
// Flow when search page sends {type:'evaluate', listingIds}:
//   1. Look up cached verdicts; only fetch the uncached ones
//   2. For each uncached id, open an inactive tab, wait for listing.js to
//      send {type:'scraped'}, then close the tab. Sequential with delay so
//      we don't open 20 tabs at once.
//   3. POST scraped batch to local helper, get verdicts
//   4. Persist new verdicts to storage and return full set to the search page

// --- Logging --------------------------------------------------------------
// mwLog buffers entries into a session-scoped ring buffer; entries drain
// either by piggybacking on the next outgoing native-messaging request (the
// common path) or via a one-shot log_flush port (backstop when buffer hits
// LOG_BACKSTOP_MAX or the buffer is non-empty for >LOG_BACKSTOP_MAX_AGE_MS).
// Errors and warns always flow through; everything else is gated by the
// `debug_logging` setting (default ON). Logging failures are dropped.
const LOG_BUFFER_KEY = "mw_log_buf";
const LOG_SEQ_KEY = "mw_log_seq";
const LOG_BUFFER_MAX = 1000;
const LOG_BACKSTOP_MAX = 200;
const LOG_BACKSTOP_MAX_AGE_MS = 5 * 60 * 1000;
const LOG_DEDUPE_CAP = 5000;
const LOG_SEEN_IDS = new Set();
const LOG_SEEN_ORDER = [];
let LOG_LAST_FLUSH_AT = Date.now();
let DEBUG_LOGGING = true;
const SESSION_ID = `bg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

chrome.storage.local.get("debug_logging").then(({ debug_logging }) => {
  DEBUG_LOGGING = debug_logging === undefined ? true : !!debug_logging;
  mwLog("session_start", "info", { sessionId: SESSION_ID });
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.debug_logging) {
    DEBUG_LOGGING = !!changes.debug_logging.newValue;
  }
});

function mwLog(category, level, data = {}) {
  enqueueLogEntry({
    ts: Date.now(),
    src: "background",
    sessionId: SESSION_ID,
    category,
    level: level || "debug",
    ...data,
  });
}

function enqueueLogEntry(entry) {
  const lvl = entry.level || "debug";
  if (lvl !== "error" && lvl !== "warn" && !DEBUG_LOGGING) return;
  if (entry.entryId) {
    if (LOG_SEEN_IDS.has(entry.entryId)) return;
    LOG_SEEN_IDS.add(entry.entryId);
    LOG_SEEN_ORDER.push(entry.entryId);
    if (LOG_SEEN_ORDER.length > LOG_DEDUPE_CAP) {
      const evict = LOG_SEEN_ORDER.shift();
      LOG_SEEN_IDS.delete(evict);
    }
  }
  // Fire-and-forget storage write; the lock keeps writers serial.
  appendToLogBuffer(entry).catch(() => {});
}

async function appendToLogBuffer(entry) {
  await navigator.locks.request("mw-log-drain", async () => {
    const data = await chrome.storage.session.get([LOG_BUFFER_KEY, LOG_SEQ_KEY]);
    const seq = (data[LOG_SEQ_KEY] || 0) + 1;
    const buf = data[LOG_BUFFER_KEY] || [];
    entry.seq = seq;
    entry.session_id = SESSION_ID;
    buf.push(entry);
    while (buf.length > LOG_BUFFER_MAX) buf.shift();
    await chrome.storage.session.set({
      [LOG_BUFFER_KEY]: buf,
      [LOG_SEQ_KEY]: seq,
    });
  });
  maybeBackstopFlush().catch(() => {});
}

async function consumeLogBuffer() {
  return navigator.locks.request("mw-log-drain", async () => {
    const data = await chrome.storage.session.get(LOG_BUFFER_KEY);
    const buf = data[LOG_BUFFER_KEY] || [];
    if (buf.length === 0) return [];
    await chrome.storage.session.set({ [LOG_BUFFER_KEY]: [] });
    LOG_LAST_FLUSH_AT = Date.now();
    return buf;
  });
}

async function peekLogBufferSize() {
  const data = await chrome.storage.session.get(LOG_BUFFER_KEY);
  return (data[LOG_BUFFER_KEY] || []).length;
}

let backstopFlushScheduled = false;

async function maybeBackstopFlush() {
  if (backstopFlushScheduled) return;
  const size = await peekLogBufferSize();
  if (size === 0) return;
  const sinceFlush = Date.now() - LOG_LAST_FLUSH_AT;
  if (size < LOG_BACKSTOP_MAX && sinceFlush < LOG_BACKSTOP_MAX_AGE_MS) return;
  backstopFlushScheduled = true;
  try {
    const logs = await consumeLogBuffer();
    if (logs.length) await flushLogsOneShot(logs);
  } catch (_) {
    // Drop on failure — the old fetch-fail behavior. Logs are best-effort.
  } finally {
    backstopFlushScheduled = false;
  }
}

// Periodic check for the age-based backstop. Cheap; only spawns a host
// process if the buffer is non-empty AND stale. setInterval may pause when
// the event page suspends — fine; the next outgoing message will drain.
setInterval(() => { maybeBackstopFlush().catch(() => {}); }, 60 * 1000);
const TAB_OPEN_DELAY_MS = 2000;
// Scrape timer budget begins AFTER the tab signals "complete", so slow
// first-tab page loads don't eat into the scraping window. The load
// failsafe is the upper bound from tab creation if "complete" never fires.
const SCRAPE_TIMEOUT_MS = 20000;
const TAB_LOAD_FAILSAFE_MS = 30000;

// Trip cost assumptions — refine in a later version with real per-vehicle data.
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const NOMINATIM_MIN_INTERVAL_MS = 1100; // be polite to OSM's free service
const OSRM_URL = "https://router.project-osrm.org/route/v1/driving";
const OSRM_MIN_INTERVAL_MS = 1100;
// Identify ourselves to Nominatim/OSRM so a friend group sharing the tool
// doesn't trip a blanket block on an anonymous User-Agent. Both upstreams
// explicitly require a contact identifier in their usage policies.
const UPSTREAM_USER_AGENT =
  "marketplace-watcher/0.1.0 (+https://github.com/coffeeowl-labs/marketplace-watcher)";
const UPSTREAM_FETCH_HEADERS = {
  "User-Agent": UPSTREAM_USER_AGENT,
  "Referer": "https://github.com/coffeeowl-labs/marketplace-watcher",
};
// Defaults; the options page overrides these via chrome.storage.local.cost_params.
const DEFAULT_COST_PARAMS = Object.freeze({
  hourly_rate: 20,
  gas_per_gallon: 5,
  mpg: 25,
});

async function getCostParams() {
  const stored = (await chrome.storage.local.get("cost_params")).cost_params || {};
  return {
    hourly_rate: Number.isFinite(stored.hourly_rate) ? stored.hourly_rate : DEFAULT_COST_PARAMS.hourly_rate,
    gas_per_gallon: Number.isFinite(stored.gas_per_gallon) ? stored.gas_per_gallon : DEFAULT_COST_PARAMS.gas_per_gallon,
    mpg: Number.isFinite(stored.mpg) ? stored.mpg : DEFAULT_COST_PARAMS.mpg,
  };
}
// OSRM gives free-flow (no-traffic) distance and duration. We deliberately
// do NOT apply a traffic multiplier — the user picks when to drive.
// Haversine fallback constants used only when OSRM is unreachable:
const FALLBACK_AVG_SPEED_MPH = 40;
const FALLBACK_ROAD_FACTOR = 1.3;

const pendingScrapes = new Map(); // listingId -> {resolve, reject, tabId}

// Eager scrape pipeline: as soon as a checkbox is checked we start scraping
// in the background. By the time the user clicks Evaluate, most or all of
// the data is already in the `scraped:<id>` cache.
const scrapeQueue = []; // FIFO of {id, resolve, reject}
const scrapeInFlight = new Map(); // listingId -> Promise<scrapedData>
let scrapeWorkerRunning = false;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "evaluate") {
    handleEvaluate(msg.listingIds, sender.tab.id, msg.options || {})
      .then(sendResponse)
      .catch((e) => sendResponse({ error: e.message }));
    return true; // async response
  }
  if (msg.type === "prefetch") {
    // Fire-and-forget: queue the scrape but don't make the sender wait.
    enqueueScrape(msg.listingId).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === "scraped") {
    // Embedded diagnostics from the listing tab — backup path in case the
    // tab was closed before its own runtime.sendMessage relays flushed.
    // We dedupe via the entry timestamp + category so re-receiving via the
    // direct relay path doesn't double-write.
    if (Array.isArray(msg.diagnostics)) {
      for (const e of msg.diagnostics) {
        e.viaScrapedBackup = true;
        enqueueLogEntry(e);
      }
    }
    const pending = pendingScrapes.get(msg.listingId);
    if (pending) pending.resolve(msg.data);
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === "log") {
    // Embedded diagnostics from content-script scrape attempts. We trust the
    // entry's own level field so a content-script error gets through even if
    // debug is off.
    if (msg.entry) enqueueLogEntry(msg.entry);
    if (Array.isArray(msg.entries)) for (const e of msg.entries) enqueueLogEntry(e);
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === "save_user_location") {
    saveUserLocation(msg.address)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
});

async function saveUserLocation(rawAddress) {
  const trimmed = (rawAddress || "").trim();
  if (!trimmed) {
    await chrome.storage.local.remove("user_location");
    return { ok: true, removed: true };
  }
  const geo = await geocode(trimmed);
  if (!geo) {
    return {
      ok: false,
      error: "Could not geocode address. Try '123 Main St, Cityville, ST 12345' format.",
    };
  }
  const result = { raw: trimmed, lat: geo.lat, lng: geo.lng, display: geo.display };
  await chrome.storage.local.set({ user_location: result });
  return { ok: true, location: result };
}

async function enqueueScrape(id) {
  // Cache hit?
  const cacheKey = `scraped:${id}`;
  const cached = (await chrome.storage.local.get(cacheKey))[cacheKey];
  if (cached) return cached;

  // Already in flight?
  if (scrapeInFlight.has(id)) return scrapeInFlight.get(id);

  const promise = new Promise((resolve, reject) => {
    scrapeQueue.push({ id, resolve, reject });
  });
  scrapeInFlight.set(id, promise);

  if (!scrapeWorkerRunning) startScrapeWorker();
  return promise;
}

async function startScrapeWorker() {
  scrapeWorkerRunning = true;
  const userLoc = await getUserLocation();
  const costParams = await getCostParams();

  while (scrapeQueue.length > 0) {
    const { id, resolve, reject } = scrapeQueue.shift();
    try {
      console.log(`[mw] eager-scraping ${id} (queue: ${scrapeQueue.length} remaining)`);
      const data = await scrapeListing(id);
      let enriched = { ...data };
      if (userLoc && data.location) {
        const listingGeo = await geocode(data.location);
        if (listingGeo) {
          const trip = await computeTrip(userLoc, listingGeo, costParams);
          Object.assign(enriched, trip);
        }
      }
      await chrome.storage.local.set({ [`scraped:${id}`]: enriched });
      resolve(enriched);
    } catch (e) {
      console.warn(`[mw] eager scrape failed ${id}:`, e.message);
      reject(e);
    } finally {
      scrapeInFlight.delete(id);
    }
    if (scrapeQueue.length > 0) await sleep(TAB_OPEN_DELAY_MS);
  }
  scrapeWorkerRunning = false;
}

// Stream a batch of listings through the native-messaging host. Returns an
// array of verdict objects in arrival order (not necessarily input order —
// chunks complete independently). The host's port-per-batch lifecycle pays
// the Python cold-start once per batch and amortizes claude CLI startup
// across chunks; no HTTP retry, no _result_cache — port-disconnect is the
// only failure mode and already-streamed verdicts are committed
// incrementally by the caller.
async function runEvaluateBatchStreaming(listings, costParams, onVerdictStreamed) {
  const traceId = `eval-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const ids = listings.map((l) => l.id);
  mwLog("helper_call_start", "info", {
    traceId,
    listingIds: ids,
    listing_count: listings.length,
  });
  const t0 = Date.now();
  const verdicts = [];
  let batchError = null;

  const piggybackLogs = await consumeLogBuffer();

  await runEvaluateBatch({
    listings,
    costParams,
    piggybackLogs,
    onVerdict: (verdict) => {
      verdicts.push(verdict);
      if (onVerdictStreamed) {
        try { onVerdictStreamed(verdict); } catch (_) {}
      }
    },
    onError: (err) => { batchError = err; },
  });

  const elapsedMs = Date.now() - t0;
  if (batchError) {
    mwLog("helper_call_end", "error", { traceId, elapsedMs, error: batchError });
    const e = new Error(`${batchError.code || "host_error"}: ${batchError.message || ""}`);
    e.batchError = batchError;
    throw e;
  }
  mwLog("helper_call_end", "info", {
    traceId, elapsedMs, status: "ok", verdicts,
  });
  return verdicts;
}

async function checkHelperHealth() {
  const piggybackLogs = await consumeLogBuffer();
  const result = await checkHealthOneShot(piggybackLogs);
  if (result.error) return false;
  return result.claude_cli && result.claude_cli.status === "ok";
}

async function handleEvaluate(listingIds, sourceTabId, options = {}) {
  const includeImages = !!options.includeImages;

  // Fail-fast: a 40-second scrape phase is wasted effort if the helper
  // isn't reachable. Confirm before we open any tabs.
  const helperUp = await checkHelperHealth();
  if (!helperUp) {
    const msg = "Helper unreachable — run `marketplace-watcher doctor` to diagnose, " +
                "or `marketplace-watcher install` if the host has never been installed.";
    console.warn("[mw] " + msg);
    sendProgress(sourceTabId, { phase: "error", error: msg });
    return { error: msg };
  }

  const cacheKeys = listingIds.map((id) => `verdict:${id}`);
  const cached = await chrome.storage.local.get(cacheKeys);
  const uncachedIds = listingIds.filter((id) => !cached[`verdict:${id}`]);

  sendProgress(sourceTabId, {
    phase: "fetching",
    total: uncachedIds.length,
    done: 0,
  });

  console.log("[mw] evaluate request", { listingIds, cached: listingIds.length - uncachedIds.length, uncached: uncachedIds.length });
  mwLog("evaluate_request", "info", {
    listingIds,
    cachedCount: listingIds.length - uncachedIds.length,
    uncachedIds,
  });

  // Queue all scrapes through the shared enqueueScrape — this dedupes
  // against any already-running eager prefetch and uses the storage cache
  // for items that finished pre-scraping while the user was curating.
  let done = 0;
  sendProgress(sourceTabId, {
    phase: "fetching",
    total: uncachedIds.length,
    done,
  });

  const scraped = await Promise.all(
    uncachedIds.map(async (id) => {
      try {
        const data = await enqueueScrape(id);
        done += 1;
        sendProgress(sourceTabId, {
          phase: "fetching",
          total: uncachedIds.length,
          done,
        });
        console.log(`[mw] ready ${id}:`, {
          title: data.title,
          price: data.price,
          location: data.location,
          descChars: (data.description || "").length,
          descSnippet: (data.description || "").slice(0, 120),
          distance_miles: data.distance_miles,
        });
        mwLog("scrape_ready", "info", {
          listingId: id,
          title: data.title,
          price: data.price,
          location: data.location,
          descChars: (data.description || "").length,
          descSnippet: (data.description || "").slice(0, 200),
          distance_miles: data.distance_miles,
        });
        const result = { id, ...data };
        // Empty description = structural scrape failed. Don't ship the
        // listing to Claude with no body — that produces a verdict based
        // only on title/price and silently hides the scrape failure from
        // the user. Mark it as an error so the search page renders an
        // ERR badge they can act on (re-analyze later, or open the
        // listing to verify FB's markup).
        if (!data.description || !data.description.trim()) {
          result.error = "No description detected on listing page";
          mwLog("scrape_no_description", "warn", { listingId: id, title: data.title, price: data.price });
        }
        return result;
      } catch (e) {
        done += 1;
        sendProgress(sourceTabId, {
          phase: "fetching",
          total: uncachedIds.length,
          done,
        });
        console.warn(`[mw] scrape failed ${id}:`, e.message);
        mwLog("scrape_failed", "error", { listingId: id, error: e.message });
        return { id, error: e.message };
      }
    })
  );

  const valid = scraped.filter((s) => !s.error);

  // Attach any user-provided context notes. These are first-party
  // observations (typically from photos) the user wants the model to weigh
  // alongside the scraped description. Persisted under `context:{id}` and
  // not cleared on re-analysis, so they carry forward across runs.
  if (valid.length) {
    const ctxKeys = valid.map((v) => `context:${v.id}`);
    const ctxStore = await chrome.storage.local.get(ctxKeys);
    for (const v of valid) {
      const note = ctxStore[`context:${v.id}`];
      if (note) v.user_context = note;
    }
  }

  // Image fetch phase. Only runs on the explicit re-analyze opt-in path. Any
  // failure aborts the whole evaluate — per the agreed decision, we don't
  // want to silently degrade to text-only when the user explicitly asked for
  // a photo-aware analysis.
  if (includeImages && valid.length) {
    sendProgress(sourceTabId, { phase: "images" });
    try {
      for (const v of valid) {
        const urls = (v.images || []).map((i) => i.url);
        if (urls.length === 0) {
          throw new Error(
            "No photos detected on this listing. Re-analyze without 'Include photos' to proceed."
          );
        }
        v.images_b64 = await fetchImagesAsBase64(v.id, urls);
      }
    } catch (e) {
      console.error("[mw] image fetch failed:", e.message);
      mwLog("image_fetch_aborted", "error", { error: e.message });
      sendProgress(sourceTabId, { phase: "error", error: e.message });
      return { error: e.message };
    }
  }

  let verdicts = [];
  const updates = {};
  if (valid.length) {
    sendProgress(sourceTabId, { phase: "evaluating" });
    console.log("[mw] sending to helper:", valid.map(v => ({
      id: v.id,
      title: v.title,
      price: v.price,
      hasContext: !!v.user_context,
      imageCount: v.images_b64 ? v.images_b64.length : 0,
    })));
    const costParams = await getCostParams();
    try {
      // Verdicts stream in as chunks complete. Persist each one to
      // chrome.storage.local immediately so a mid-batch disconnect leaves
      // the completed verdicts cached — the next attempt will see them in
      // the verdict:<id> cache and skip them.
      verdicts = await runEvaluateBatchStreaming(valid, costParams, async (v) => {
        const item = valid.find((s) => s.id === v.id);
        const imgCount = item?.images_b64 ? item.images_b64.length : 0;
        const entry = {
          ...v,
          title: item?.title,
          price: item?.price,
          location: item?.location,
          description: item?.description,
          user_context: item?.user_context,
          distance_miles: item?.distance_miles,
          drive_time_one_way_min: item?.drive_time_one_way_min,
          round_trip_gas_cost: item?.round_trip_gas_cost,
          round_trip_time_cost: item?.round_trip_time_cost,
          images_included: imgCount > 0,
          image_count: imgCount,
          evaluatedAt: Date.now(),
        };
        updates[`verdict:${v.id}`] = entry;
        await chrome.storage.local.set({ [`verdict:${v.id}`]: entry });
      });
      console.log("[mw] verdicts:", verdicts);
    } catch (e) {
      console.error("[mw] helper error:", e.message);
      sendProgress(sourceTabId, { phase: "error", error: e.message });
      // Don't abort — some verdicts may have streamed in already; preserve
      // them. Fall through to return them with an error marker for the rest.
    }
  }
  // Persist scrape-side failures (no description, scrape timeout, etc.) too,
  // so the ERR badge survives page reloads instead of going back to an
  // empty checkbox. Re-analyzing a listing busts the cache, so this is
  // sticky-but-recoverable.
  for (const s of scraped) {
    if (!s.error) continue;
    updates[`verdict:${s.id}`] = {
      id: s.id,
      error: s.error,
      title: s.title,
      price: s.price,
      location: s.location,
      description: s.description,
      evaluatedAt: Date.now(),
    };
  }
  if (Object.keys(updates).length) {
    await chrome.storage.local.set(updates);
  }

  const allVerdicts = listingIds.map((id) => {
    if (cached[`verdict:${id}`]) return cached[`verdict:${id}`];
    if (updates[`verdict:${id}`]) return updates[`verdict:${id}`];
    const failed = scraped.find((s) => s.id === id && s.error);
    return { id, error: failed ? failed.error : "evaluation failed" };
  });

  sendProgress(sourceTabId, { phase: "done" });
  return { verdicts: allVerdicts };
}

async function scrapeListing(listingId) {
  const url = `https://www.facebook.com/marketplace/item/${listingId}/`;
  const tab = await chrome.tabs.create({ url, active: false });

  return new Promise((resolve, reject) => {
    let scrapeTimer = null;
    let settled = false;

    const cleanup = () => {
      settled = true;
      if (scrapeTimer) clearTimeout(scrapeTimer);
      clearTimeout(loadFailsafeTimer);
      chrome.tabs.onUpdated.removeListener(onTabUpdated);
      pendingScrapes.delete(listingId);
      chrome.tabs.remove(tab.id).catch(() => {});
    };

    pendingScrapes.set(listingId, {
      resolve: (data) => {
        if (settled) return;
        cleanup();
        resolve(data);
      },
      reject: (err) => {
        if (settled) return;
        cleanup();
        reject(err);
      },
      tabId: tab.id,
    });

    const armScrapeTimer = () => {
      if (settled || scrapeTimer) return;
      scrapeTimer = setTimeout(() => {
        if (settled) return;
        cleanup();
        reject(new Error("scrape timeout"));
      }, SCRAPE_TIMEOUT_MS);
    };

    const onTabUpdated = (id, info) => {
      if (id !== tab.id || info.status !== "complete") return;
      armScrapeTimer();
    };
    chrome.tabs.onUpdated.addListener(onTabUpdated);

    // Failsafe in case "complete" never fires (some FB pages keep loading
    // sub-resources indefinitely). After this window, start the scrape
    // timer regardless so we don't hang forever.
    const loadFailsafeTimer = setTimeout(armScrapeTimer, TAB_LOAD_FAILSAFE_MS);
  });
}

function sendProgress(tabId, payload) {
  chrome.tabs.sendMessage(tabId, { type: "progress", ...payload }).catch(() => {});
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Image fetch --------------------------------------------------------
//
// Re-analyze with "Include photos" downloads each image URL the listing
// scraper found and encodes it as base64 for transport to the helper. We
// validate content-type and cap per-image bytes; any failure aborts the
// whole evaluate (the user opted in expecting photo-aware analysis, not
// silent text-only fallback).

const IMAGE_MAX_BYTES = 2 * 1024 * 1024;

async function fetchImagesAsBase64(listingId, urls) {
  const out = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const t0 = Date.now();
    let resp;
    try {
      // No explicit Referer — fbcdn.net mostly serves images publicly. If we
      // start seeing 403s, add `headers: {Referer: "https://www.facebook.com/"}`.
      resp = await fetch(url);
    } catch (e) {
      throw new Error(`image fetch failed (${i + 1}/${urls.length}): ${e.message}`);
    }
    if (!resp.ok) {
      throw new Error(`image fetch ${resp.status} (${i + 1}/${urls.length})`);
    }
    const contentType = (resp.headers.get("content-type") || "").toLowerCase();
    if (!contentType.startsWith("image/")) {
      throw new Error(`image ${i + 1} returned non-image content-type: ${contentType}`);
    }
    const blob = await resp.blob();
    if (blob.size > IMAGE_MAX_BYTES) {
      throw new Error(
        `image ${i + 1} too large: ${blob.size} bytes (cap ${IMAGE_MAX_BYTES})`
      );
    }
    const b64 = await blobToBase64(blob);
    out.push({ b64, mime: blob.type || contentType, bytes: blob.size });
    mwLog("image_fetched", "info", {
      listingId,
      index: i,
      bytes: blob.size,
      mime: blob.type,
      elapsedMs: Date.now() - t0,
    });
  }
  return out;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const comma = dataUrl.indexOf(",");
      resolve(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl);
    };
    reader.onerror = () => reject(reader.error || new Error("FileReader failed"));
    reader.readAsDataURL(blob);
  });
}

// --- Geocoding & trip-cost helpers --------------------------------------

let lastNominatimAt = 0;

async function geocode(query) {
  if (!query || !query.trim()) return null;
  const key = `geo:${query.trim().toLowerCase()}`;
  const cached = (await chrome.storage.local.get(key))[key];
  if (cached) return cached;

  const wait = NOMINATIM_MIN_INTERVAL_MS - (Date.now() - lastNominatimAt);
  if (wait > 0) await sleep(wait);
  lastNominatimAt = Date.now();

  // countrycodes=us biases lookups to US results — bare ZIP codes otherwise
  // can match international postal codes (e.g. SF's 941xx collides with a
  // postal code in Vladivostok). Revisit if non-US use is needed.
  const url = `${NOMINATIM_URL}?q=${encodeURIComponent(query)}&format=json&limit=1&countrycodes=us`;
  try {
    const resp = await fetch(url, { headers: UPSTREAM_FETCH_HEADERS });
    if (!resp.ok) {
      console.warn(`[mw] geocode ${query}: ${resp.status}`);
      return null;
    }
    const arr = await resp.json();
    if (!arr.length) return null;
    const result = {
      lat: parseFloat(arr[0].lat),
      lng: parseFloat(arr[0].lon),
      display: arr[0].display_name,
    };
    await chrome.storage.local.set({ [key]: result });
    return result;
  } catch (e) {
    console.warn(`[mw] geocode ${query} failed:`, e.message);
    return null;
  }
}

async function getUserLocation() {
  const stored = (await chrome.storage.local.get("user_location")).user_location;
  if (!stored || !stored.raw) return null;
  if (stored.lat != null && stored.lng != null) return stored;
  const geo = await geocode(stored.raw);
  if (!geo) return null;
  const merged = { raw: stored.raw, ...geo };
  await chrome.storage.local.set({ user_location: merged });
  return merged;
}

let lastOsrmAt = 0;

async function osrmRoute(from, to) {
  const key = `route:${from.lat.toFixed(4)},${from.lng.toFixed(4)}>${to.lat.toFixed(4)},${to.lng.toFixed(4)}`;
  const cached = (await chrome.storage.local.get(key))[key];
  if (cached) return cached;

  const wait = OSRM_MIN_INTERVAL_MS - (Date.now() - lastOsrmAt);
  if (wait > 0) await sleep(wait);
  lastOsrmAt = Date.now();

  const url = `${OSRM_URL}/${from.lng},${from.lat};${to.lng},${to.lat}?overview=false`;
  try {
    const resp = await fetch(url, { headers: UPSTREAM_FETCH_HEADERS });
    if (!resp.ok) {
      console.warn(`[mw] OSRM ${resp.status}`);
      return null;
    }
    const data = await resp.json();
    if (!data.routes || !data.routes.length) return null;
    const r = data.routes[0];
    const result = { meters: r.distance, seconds: r.duration };
    await chrome.storage.local.set({ [key]: result });
    return result;
  } catch (e) {
    console.warn("[mw] OSRM failed:", e.message);
    return null;
  }
}

function tripFromMilesAndMinutes(miles, minutesOneWay, costParams) {
  const gas = ((miles * 2) / costParams.mpg) * costParams.gas_per_gallon;
  const time = (minutesOneWay / 60) * 2 * costParams.hourly_rate;
  return {
    distance_miles: round1(miles),
    drive_time_one_way_min: Math.round(minutesOneWay),
    round_trip_gas_cost: round2(gas),
    round_trip_time_cost: round2(time),
  };
}

async function computeTrip(from, to, costParams) {
  const route = await osrmRoute(from, to);
  if (route) {
    const miles = route.meters / 1609.344;
    const minutes = route.seconds / 60;
    return tripFromMilesAndMinutes(miles, minutes, costParams);
  }
  // OSRM unreachable — fall back to crow-flies estimate
  const miles = haversineMiles(from, to) * FALLBACK_ROAD_FACTOR;
  const minutes = (miles / FALLBACK_AVG_SPEED_MPH) * 60;
  return tripFromMilesAndMinutes(miles, minutes, costParams);
}

function haversineMiles(a, b) {
  const R = 3958.8; // earth radius in miles
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function round1(n) { return Math.round(n * 10) / 10; }
function round2(n) { return Math.round(n * 100) / 100; }
