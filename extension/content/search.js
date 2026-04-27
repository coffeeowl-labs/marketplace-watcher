// content/search.js — runs on Marketplace search results pages.
// Adds a checkbox to each unevaluated card, a verdict badge to cached ones,
// and a floating Evaluate (N) button that batches 1-20 selected listings.

const HARD_CAP = 20;
const SOFT_FLOOR = 5;

const selectedIds = new Set();
let cachedVerdicts = {}; // id -> verdict object
let mutationDebounceTimer = null;

(async () => {
  cachedVerdicts = await loadCachedVerdicts();
  ensureFAB();
  setupObserver();
  attachOverlays();
})();

async function loadCachedVerdicts() {
  const all = await chrome.storage.local.get(null);
  const out = {};
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith("verdict:")) out[k.slice("verdict:".length)] = v;
  }
  return out;
}

function setupObserver() {
  const observer = new MutationObserver(() => {
    clearTimeout(mutationDebounceTimer);
    mutationDebounceTimer = setTimeout(attachOverlays, 200);
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

function attachOverlays() {
  const links = document.querySelectorAll('a[href*="/marketplace/item/"]');
  for (const link of links) {
    const id = extractListingId(link.getAttribute("href") || "");
    if (!id) continue;

    // FB's card link is display:inline; anchoring an absolute child to it
    // creates a degenerate line-box containing block. Use the link's parent
    // DIV instead — diagnostics confirmed it has the same bounds and is
    // already block-level, so we can set position:relative without touching
    // FB's own layout properties on the link.
    const card = link.parentElement || link;
    if (card.dataset.mwCard === "1") continue;
    card.dataset.mwCard = "1";

    const cs = getComputedStyle(card);
    if (cs.position === "static") card.style.position = "relative";

    if (cachedVerdicts[id]) {
      attachBadge(card, cachedVerdicts[id]);
    } else {
      attachCheckbox(card, id);
    }
  }
}

function attachCheckbox(card, id) {
  const box = document.createElement("div");
  box.className = "mw-checkbox";
  box.dataset.mwId = id;
  box.textContent = "";
  const apply = () => {
    if (selectedIds.has(id)) {
      box.classList.add("mw-checked");
      box.textContent = "✓";
    } else {
      box.classList.remove("mw-checked");
      box.textContent = "";
    }
  };
  box.addEventListener(
    "click",
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (selectedIds.has(id)) {
        selectedIds.delete(id);
      } else {
        if (selectedIds.size >= HARD_CAP) {
          flashFAB("max 20 selected");
          return;
        }
        selectedIds.add(id);
      }
      apply();
      updateFAB();
    },
    true
  );
  apply();
  card.appendChild(box);
}

function attachBadge(card, verdict) {
  const badge = document.createElement("div");
  const v = verdict.verdict || "error";
  badge.className = `mw-badge mw-${v}`;
  badge.textContent = (verdict.error ? "ERR" : v).toUpperCase();
  badge.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onReEvaluateBadge(verdict.id);
  });
  // Tooltip surfaces the full scraped payload alongside the verdict so
  // we can sanity-check what the model actually saw.
  const lines = [];
  if (verdict.reason) lines.push(`REASON: ${verdict.reason}`);
  if (verdict.error) lines.push(`ERROR: ${verdict.error}`);
  if (verdict.title) lines.push(`\nTitle: ${verdict.title}`);
  if (verdict.price) lines.push(`Price: ${verdict.price}`);
  if (verdict.location) lines.push(`Location: ${verdict.location}`);
  if (verdict.distance_miles != null) {
    const gas = verdict.round_trip_gas_cost ?? 0;
    const time = verdict.round_trip_time_cost ?? 0;
    const mins = verdict.drive_time_one_way_min ?? 0;
    lines.push(
      `Distance: ${verdict.distance_miles} mi (~${mins} min one way)`
    );
    lines.push(
      `Round-trip cost: $${gas.toFixed(2)} gas + $${time.toFixed(2)} time = $${(gas + time).toFixed(2)}`
    );
  }
  if (verdict.description) {
    const d = verdict.description;
    lines.push(`\nDescription (${d.length} chars):\n${d.slice(0, 600)}${d.length > 600 ? "…" : ""}`);
  }
  lines.push("\n(right-click to re-evaluate)");
  badge.title = lines.join("\n");
  card.appendChild(badge);
}

function ensureFAB() {
  if (document.getElementById("mw-bar")) return;
  const bar = document.createElement("div");
  bar.id = "mw-bar";

  const fab = document.createElement("button");
  fab.id = "mw-fab";
  fab.type = "button";
  fab.addEventListener("click", onEvaluateClick);
  bar.appendChild(fab);

  const setLoc = document.createElement("button");
  setLoc.id = "mw-setloc";
  setLoc.type = "button";
  setLoc.textContent = "Set Location";
  setLoc.addEventListener("click", onSetLocationClick);
  bar.appendChild(setLoc);

  const clear = document.createElement("button");
  clear.id = "mw-clear";
  clear.type = "button";
  clear.textContent = "Clear Cache";
  clear.addEventListener("click", onClearCacheClick);
  bar.appendChild(clear);

  document.body.appendChild(bar);
  updateFAB();
  refreshSetLocLabel();
}

async function refreshSetLocLabel() {
  const btn = document.getElementById("mw-setloc");
  if (!btn) return;
  const stored = (await chrome.storage.local.get("user_location")).user_location;
  if (stored && stored.raw) {
    btn.textContent = `📍 ${stored.raw}`;
    btn.title = stored.display
      ? `Geocoded to: ${stored.display}\nClick to change.`
      : "Click to change.";
  } else {
    btn.textContent = "Set Location";
    btn.title = "Set your location to enable distance/trip cost analysis.";
  }
}

async function onSetLocationClick() {
  const stored = (await chrome.storage.local.get("user_location")).user_location;
  const current = stored?.raw || "";
  const input = prompt(
    "Your location (ZIP code, city, or address):\n\nUsed to estimate distance, drive time, and gas cost. Leave blank to clear.",
    current
  );
  if (input === null) return;
  const trimmed = input.trim();
  if (!trimmed) {
    await chrome.storage.local.remove("user_location");
  } else {
    // Store raw only; background will geocode on next eval and persist lat/lng.
    await chrome.storage.local.set({ user_location: { raw: trimmed } });
  }
  refreshSetLocLabel();
}

async function ensureUserLocation() {
  const stored = (await chrome.storage.local.get("user_location")).user_location;
  if (stored && stored.raw) return true;
  const input = prompt(
    "Set your location to enable distance / trip-cost analysis.\n\nEnter a ZIP code, city, or address (or press Cancel to skip):"
  );
  if (input === null || !input.trim()) return false;
  await chrome.storage.local.set({ user_location: { raw: input.trim() } });
  refreshSetLocLabel();
  return true;
}

async function onClearCacheClick() {
  const count = Object.keys(cachedVerdicts).length;
  if (!confirm(`Clear ${count} cached verdict${count === 1 ? "" : "s"}?`)) return;
  await chrome.storage.local.clear();
  cachedVerdicts = {};
  selectedIds.clear();
  refreshAllOverlays();
  updateFAB();
}

function updateFAB() {
  const fab = document.getElementById("mw-fab");
  if (!fab) return;
  const n = selectedIds.size;
  let label = `Evaluate (${n})`;
  if (n > 0 && n < SOFT_FLOOR) label += " — 5+ recommended";
  fab.textContent = label;
  fab.disabled = n === 0;
}

function flashFAB(text) {
  const fab = document.getElementById("mw-fab");
  if (!fab) return;
  const prev = fab.textContent;
  fab.textContent = text;
  setTimeout(() => {
    fab.textContent = prev;
    updateFAB();
  }, 1500);
}

async function onReEvaluateBadge(id) {
  const v = cachedVerdicts[id];
  const label = v?.title ? `"${v.title}"` : id;
  if (!confirm(`Re-evaluate ${label}?`)) return;

  delete cachedVerdicts[id];
  await chrome.storage.local.remove(`verdict:${id}`);

  await ensureUserLocation();

  const fab = document.getElementById("mw-fab");
  fab.disabled = true;
  fab.textContent = "Re-evaluating…";

  try {
    const response = await chrome.runtime.sendMessage({
      type: "evaluate",
      listingIds: [id],
    });
    if (!response || response.error) {
      fab.textContent = `Error: ${response?.error || "no response"}`;
      setTimeout(updateFAB, 5000);
      return;
    }
    for (const nv of response.verdicts || []) {
      cachedVerdicts[nv.id] = nv;
    }
    refreshAllOverlays();
    updateFAB();
  } catch (e) {
    fab.textContent = `Error: ${e.message}`;
    setTimeout(updateFAB, 5000);
  }
}

async function onEvaluateClick() {
  const fab = document.getElementById("mw-fab");
  await ensureUserLocation(); // soft — proceeds even if user skips
  fab.disabled = true;
  const ids = Array.from(selectedIds);
  fab.textContent = `Starting (${ids.length})…`;

  try {
    const response = await chrome.runtime.sendMessage({
      type: "evaluate",
      listingIds: ids,
    });
    if (!response) {
      fab.textContent = "Error: no response";
      setTimeout(updateFAB, 4000);
      return;
    }
    if (response.error) {
      fab.textContent = `Error: ${response.error}`;
      setTimeout(updateFAB, 5000);
      return;
    }
    for (const v of response.verdicts || []) {
      cachedVerdicts[v.id] = v;
    }
    selectedIds.clear();
    refreshAllOverlays();
    updateFAB();
  } catch (e) {
    fab.textContent = `Error: ${e.message}`;
    setTimeout(updateFAB, 5000);
  }
}

function refreshAllOverlays() {
  document.querySelectorAll('[data-mw-card="1"]').forEach((el) => {
    el.removeAttribute("data-mw-card");
    el.querySelectorAll(".mw-checkbox, .mw-badge").forEach((n) => n.remove());
  });
  attachOverlays();
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== "progress") return;
  const fab = document.getElementById("mw-fab");
  if (!fab) return;
  if (msg.phase === "fetching") {
    fab.textContent = `Fetching ${msg.done}/${msg.total}…`;
  } else if (msg.phase === "evaluating") {
    fab.textContent = "Evaluating with Claude…";
  } else if (msg.phase === "done") {
    fab.textContent = "Done";
  } else if (msg.phase === "error") {
    fab.textContent = `Error: ${msg.error}`;
  }
});

function extractListingId(href) {
  const m = href.match(/\/marketplace\/item\/(\d+)/);
  return m ? m[1] : null;
}
