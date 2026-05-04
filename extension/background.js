// background.js — orchestrates scraping + evaluation
//
// Flow when search page sends {type:'evaluate', listingIds}:
//   1. Look up cached verdicts; only fetch the uncached ones
//   2. For each uncached id, open an inactive tab, wait for listing.js to
//      send {type:'scraped'}, then close the tab. Sequential with delay so
//      we don't open 20 tabs at once.
//   3. POST scraped batch to local helper, get verdicts
//   4. Persist new verdicts to storage and return full set to the search page

const HELPER_URL = "http://127.0.0.1:8787/evaluate";
const HELPER_HEALTH_URL = "http://127.0.0.1:8787/health";
const HELPER_LOG_URL = "http://127.0.0.1:8787/log";
const HELPER_HEALTH_TIMEOUT_MS = 2000;

// --- Logging --------------------------------------------------------------
// mwLog buffers entries and flushes them to the helper's /log endpoint.
// Errors and warnings always flow through; debug-level entries are gated by
// the `debug_logging` setting (configurable in the options page, default ON).
// Logging failures are silently dropped — never block real work.
const LOG_FLUSH_MS = 1000;
const LOG_BATCH_MAX = 50;
const LOG_BUFFER = [];
let DEBUG_LOGGING = false;
let SESSION_ID = `bg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

chrome.storage.local.get("debug_logging").then(({ debug_logging }) => {
  if (debug_logging !== undefined) DEBUG_LOGGING = !!debug_logging;
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

// Cap on the dedupe set so we don't grow it forever. Entries older than this
// many recent IDs may be re-recorded — fine, since the duplicates window is
// narrow (the lifetime of a single scrape).
const LOG_DEDUPE_CAP = 5000;
const LOG_SEEN_IDS = new Set();
const LOG_SEEN_ORDER = [];

function enqueueLogEntry(entry) {
  const lvl = entry.level || "debug";
  // Errors and warns are always recorded. Everything else (info/debug) is
  // gated behind the debug toggle.
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
  LOG_BUFFER.push(entry);
  if (LOG_BUFFER.length >= LOG_BATCH_MAX) flushLogs();
}

async function flushLogs() {
  if (LOG_BUFFER.length === 0) return;
  const batch = LOG_BUFFER.splice(0, LOG_BUFFER.length);
  try {
    await fetch(HELPER_LOG_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: batch }),
    });
  } catch (e) {
    // Helper may be down — don't requeue (would grow unboundedly). Drop.
  }
}

setInterval(flushLogs, LOG_FLUSH_MS);
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
const HOURLY_TIME_COST = 20;
const GAS_COST_PER_GALLON = 5;
const AVG_MPG = 25;
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
});

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

  while (scrapeQueue.length > 0) {
    const { id, resolve, reject } = scrapeQueue.shift();
    try {
      console.log(`[mw] eager-scraping ${id} (queue: ${scrapeQueue.length} remaining)`);
      const data = await scrapeListing(id);
      let enriched = { ...data };
      if (userLoc && data.location) {
        const listingGeo = await geocode(data.location);
        if (listingGeo) {
          const trip = await computeTrip(userLoc, listingGeo);
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

// Firefox MV3's background event page can drop a long-running fetch even
// with the keepalive (see setInterval below). The helper caches verdicts
// by request-hash for 5 minutes, so retrying the same body is free — it
// either returns cached results or joins the still-running computation
// instead of starting a fresh Claude call.
async function postEvaluateWithRetry(payload, maxAttempts = 2) {
  const body = JSON.stringify(payload);
  const traceId = `eval-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const ids = (payload.listings || []).map((l) => l.id);
  mwLog("helper_call_start", "info", {
    traceId,
    attempts: maxAttempts,
    listingIds: ids,
    bodyChars: body.length,
  });
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const t0 = Date.now();
    try {
      const resp = await fetch(HELPER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      const elapsedMs = Date.now() - t0;
      if (!resp.ok) {
        const text = await resp.text();
        // 5xx might be transient; 4xx won't get better with a retry.
        if (resp.status >= 500 && attempt < maxAttempts) {
          lastErr = new Error(`helper ${resp.status}: ${text.slice(0, 200)}`);
          console.warn(`[mw] helper ${resp.status}, retrying (attempt ${attempt + 1}/${maxAttempts})`);
          mwLog("helper_call_retry", "warn", { traceId, attempt, status: resp.status, elapsedMs, body: text.slice(0, 500) });
          await sleep(2000);
          continue;
        }
        mwLog("helper_call_end", "error", { traceId, attempt, status: resp.status, elapsedMs, body: text.slice(0, 500) });
        throw new Error(`helper ${resp.status}: ${text.slice(0, 200)}`);
      }
      const json = await resp.json();
      mwLog("helper_call_end", "info", {
        traceId, attempt, elapsedMs, status: 200,
        verdicts: json.verdicts || [],
      });
      return json.verdicts || [];
    } catch (e) {
      const elapsedMs = Date.now() - t0;
      lastErr = e;
      if (attempt < maxAttempts) {
        console.warn(`[mw] helper fetch failed (${e.message}), retrying (attempt ${attempt + 1}/${maxAttempts})`);
        mwLog("helper_call_retry", "warn", { traceId, attempt, elapsedMs, error: e.message });
        await sleep(2000);
        continue;
      }
      mwLog("helper_call_end", "error", { traceId, attempt, elapsedMs, error: e.message });
      throw e;
    }
  }
  throw lastErr;
}

async function checkHelperHealth() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HELPER_HEALTH_TIMEOUT_MS);
  try {
    const resp = await fetch(HELPER_HEALTH_URL, { signal: ctrl.signal });
    return resp.ok;
  } catch (e) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function handleEvaluate(listingIds, sourceTabId, options = {}) {
  const includeImages = !!options.includeImages;

  // Fail-fast: a 40-second scrape phase is wasted effort if the helper
  // isn't running. Confirm reachability before we open any tabs.
  const helperUp = await checkHelperHealth();
  if (!helperUp) {
    const msg = "Helper not running — start it with: python3 helper/server.py";
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
  if (valid.length) {
    sendProgress(sourceTabId, { phase: "evaluating" });
    console.log("[mw] sending to helper:", valid.map(v => ({
      id: v.id,
      title: v.title,
      price: v.price,
      hasContext: !!v.user_context,
      imageCount: v.images_b64 ? v.images_b64.length : 0,
    })));
    try {
      verdicts = await postEvaluateWithRetry({ listings: valid });
      console.log("[mw] verdicts:", verdicts);
    } catch (e) {
      console.error("[mw] helper error:", e.message);
      sendProgress(sourceTabId, { phase: "error", error: e.message });
      return { error: e.message };
    }
  }

  const updates = {};
  for (const v of verdicts) {
    const item = valid.find((s) => s.id === v.id);
    const imgCount = item?.images_b64 ? item.images_b64.length : 0;
    updates[`verdict:${v.id}`] = {
      ...v,
      title: item?.title,
      price: item?.price,
      location: item?.location,
      description: item?.description, // store so user can verify what was evaluated
      user_context: item?.user_context,
      distance_miles: item?.distance_miles,
      drive_time_one_way_min: item?.drive_time_one_way_min,
      round_trip_gas_cost: item?.round_trip_gas_cost,
      round_trip_time_cost: item?.round_trip_time_cost,
      images_included: imgCount > 0,
      image_count: imgCount,
      evaluatedAt: Date.now(),
    };
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

// Firefox MV3 background scripts are non-persistent event pages and can be
// suspended after ~30s of "inactivity." Active fetches *should* count, but
// the implementation occasionally drops long requests, surfacing as a
// BrokenPipeError on the helper side. Poking a chrome.runtime API every
// 20s registers as activity and keeps the page alive across long batches.
setInterval(() => {
  chrome.runtime.getPlatformInfo().catch(() => {});
}, 20000);

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
    const resp = await fetch(url);
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
    const resp = await fetch(url);
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

function tripFromMilesAndMinutes(miles, minutesOneWay) {
  const gas = ((miles * 2) / AVG_MPG) * GAS_COST_PER_GALLON;
  const time = (minutesOneWay / 60) * 2 * HOURLY_TIME_COST;
  return {
    distance_miles: round1(miles),
    drive_time_one_way_min: Math.round(minutesOneWay),
    round_trip_gas_cost: round2(gas),
    round_trip_time_cost: round2(time),
  };
}

async function computeTrip(from, to) {
  const route = await osrmRoute(from, to);
  if (route) {
    const miles = route.meters / 1609.344;
    const minutes = route.seconds / 60;
    return tripFromMilesAndMinutes(miles, minutes);
  }
  // OSRM unreachable — fall back to crow-flies estimate
  const miles = haversineMiles(from, to) * FALLBACK_ROAD_FACTOR;
  const minutes = (miles / FALLBACK_AVG_SPEED_MPH) * 60;
  return tripFromMilesAndMinutes(miles, minutes);
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
