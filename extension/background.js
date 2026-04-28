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
const HELPER_HEALTH_TIMEOUT_MS = 2000;
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
    handleEvaluate(msg.listingIds, sender.tab.id)
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
    const pending = pendingScrapes.get(msg.listingId);
    if (pending) pending.resolve(msg.data);
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

async function handleEvaluate(listingIds, sourceTabId) {
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
          distance_miles: data.distance_miles,
        });
        return { id, ...data };
      } catch (e) {
        done += 1;
        sendProgress(sourceTabId, {
          phase: "fetching",
          total: uncachedIds.length,
          done,
        });
        console.warn(`[mw] scrape failed ${id}:`, e.message);
        return { id, error: e.message };
      }
    })
  );

  const valid = scraped.filter((s) => !s.error);
  let verdicts = [];
  if (valid.length) {
    sendProgress(sourceTabId, { phase: "evaluating" });
    console.log("[mw] sending to helper:", valid.map(v => ({id: v.id, title: v.title, price: v.price})));
    try {
      const resp = await fetch(HELPER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listings: valid }),
      });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`helper ${resp.status}: ${text.slice(0, 200)}`);
      }
      const json = await resp.json();
      verdicts = json.verdicts || [];
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
    updates[`verdict:${v.id}`] = {
      ...v,
      title: item?.title,
      price: item?.price,
      location: item?.location,
      description: item?.description, // store so user can verify what was evaluated
      distance_miles: item?.distance_miles,
      drive_time_one_way_min: item?.drive_time_one_way_min,
      round_trip_gas_cost: item?.round_trip_gas_cost,
      round_trip_time_cost: item?.round_trip_time_cost,
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
