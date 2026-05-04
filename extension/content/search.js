// content/search.js — runs on Marketplace search results pages.
// Adds a checkbox to each unevaluated card, a verdict badge to cached ones,
// and a floating Evaluate (N) button that batches 1-20 selected listings.

const HARD_CAP = 20;
const SOFT_FLOOR = 5;

const selectedIds = new Set();
let cachedVerdicts = {}; // id -> verdict object
let cachedContexts = {}; // id -> user-provided context string
let mutationDebounceTimer = null;

// Display order of filter rows in the popover.
const FILTER_KINDS = [
  { key: "steal", label: "Steal" },
  { key: "good", label: "Good" },
  { key: "fair", label: "Fair" },
  { key: "skip", label: "Skip" },
  { key: "error", label: "Error" },
  { key: "unanalyzed", label: "Unanalyzed" },
  { key: "sponsored", label: "Sponsored / Ads" },
];

// All visible by default except sponsored (nobody wants ads in their results).
// Persisted under `filter_visibility`.
const filterState = {
  steal: true,
  good: true,
  fair: true,
  skip: true,
  error: true,
  unanalyzed: true,
  sponsored: false,
};

(async () => {
  ({ verdicts: cachedVerdicts, contexts: cachedContexts } = await loadCachedData());
  ensureFAB();
  await loadFilterState();
  setupObserver();
  attachOverlays();
})();

async function loadFilterState() {
  const stored = await chrome.storage.local.get([
    "filter_visibility",
    "hide_skips", "hide_fair", "hide_good", // legacy keys, migrate once
  ]);
  if (stored.filter_visibility) {
    Object.assign(filterState, stored.filter_visibility);
  } else if (stored.hide_skips || stored.hide_fair || stored.hide_good) {
    if (stored.hide_skips) filterState.skip = false;
    if (stored.hide_fair) filterState.fair = false;
    if (stored.hide_good) filterState.good = false;
    await chrome.storage.local.set({ filter_visibility: { ...filterState } });
    await chrome.storage.local.remove(["hide_skips", "hide_fair", "hide_good"]);
  }
  applyFilterState();
}

function applyFilterState() {
  for (const k of Object.keys(filterState)) {
    document.body.classList.toggle(`mw-hide-${k}`, !filterState[k]);
  }
  refreshFilterButton();
  refreshPopoverCheckboxes();
}

async function toggleFilterKind(key) {
  filterState[key] = !filterState[key];
  await chrome.storage.local.set({ filter_visibility: { ...filterState } });
  applyFilterState();
}

function refreshFilterButton() {
  const btn = document.getElementById("mw-filter");
  if (!btn) return;
  const visible = Object.values(filterState).filter(Boolean).length;
  const total = Object.keys(filterState).length;
  btn.textContent = `Filter (${visible}/${total})`;
  btn.classList.toggle("mw-active", visible < total);
}

function buildFilterPopover() {
  const pop = document.createElement("div");
  pop.id = "mw-filter-popover";
  for (const kind of FILTER_KINDS) {
    const row = document.createElement("label");
    row.className = "mw-filter-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.dataset.kind = kind.key;
    cb.addEventListener("change", () => toggleFilterKind(kind.key));
    const swatch = document.createElement("span");
    swatch.className = `mw-filter-swatch mw-filter-swatch-${kind.key}`;
    const label = document.createElement("span");
    label.textContent = kind.label;
    row.append(cb, swatch, label);
    pop.appendChild(row);
  }
  return pop;
}

function refreshPopoverCheckboxes() {
  const pop = document.getElementById("mw-filter-popover");
  if (!pop) return;
  for (const cb of pop.querySelectorAll("input[type=checkbox]")) {
    cb.checked = !!filterState[cb.dataset.kind];
  }
}

function toggleFilterPopover(force) {
  const pop = document.getElementById("mw-filter-popover");
  if (!pop) return;
  const open = force !== undefined ? force : !pop.classList.contains("mw-open");
  pop.classList.toggle("mw-open", open);
}

async function loadCachedData() {
  const all = await chrome.storage.local.get(null);
  const verdicts = {};
  const contexts = {};
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith("verdict:")) verdicts[k.slice("verdict:".length)] = v;
    else if (k.startsWith("context:")) contexts[k.slice("context:".length)] = v;
  }
  return { verdicts, contexts };
}

function setupObserver() {
  const observer = new MutationObserver(() => {
    clearTimeout(mutationDebounceTimer);
    mutationDebounceTimer = setTimeout(attachOverlays, 200);
  });
  // We need attribute observation (filtered to href) because FB sometimes
  // recycles a card wrapper by mutating only the link's href in place —
  // childList alone misses that and the badge ends up pinned to the wrong
  // listing. The filter keeps the observer from firing on every unrelated
  // attribute change.
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["href"],
  });
}

function attachOverlays() {
  // Validation sweep: confirm each marked card still hosts a link pointing
  // at the same listing it was marked for. FB's virtualizer can swap a
  // wrapper's contents (or the link's href in place) in ways our observer
  // doesn't always catch in time, leaving a stale badge pinned to an
  // unrelated card. Scrub any mismatches before re-attaching below.
  for (const el of document.querySelectorAll("[data-mw-card]")) {
    const inner = el.querySelector('a[href*="/marketplace/item/"]');
    const innerId = inner ? extractListingId(inner.getAttribute("href") || "") : null;
    if (innerId !== el.dataset.mwCard) {
      el.removeAttribute("data-mw-card");
      el.querySelectorAll(".mw-checkbox, .mw-badge").forEach((n) => n.remove());
    }
  }

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

    // FB virtualizes its scroll list — it swaps a card wrapper's contents
    // for a different listing without removing the wrapper itself. We bind
    // the marker to the listing ID (not a boolean) so we detect that the
    // wrapper now hosts a different listing and rebuild the overlay
    // instead of leaving a stale badge pinned to an unrelated card.
    if (card.dataset.mwCard === id) continue;
    if (card.dataset.mwCard) {
      card.querySelectorAll(".mw-checkbox, .mw-badge").forEach((n) => n.remove());
    }
    card.dataset.mwCard = id;

    const cs = getComputedStyle(card);
    if (cs.position === "static") card.style.position = "relative";

    if (cachedVerdicts[id]) {
      attachBadge(card, cachedVerdicts[id]);
    } else {
      attachCheckbox(card, id);
    }
  }
  markSponsoredCards();
}

function markSponsoredCards() {
  // Marketplace ads are cards whose <a href> points directly at the
  // advertiser's external site (e.g. fiido.com, lectricebikes.com)
  // instead of /marketplace/item/<id>. The destination URL is the most
  // reliable signal — FB can obfuscate "Sponsored" labels but can't
  // change where the ad needs to send the click.
  //
  // FB nests several <a> tags per card (a hidden one + a "Visit site"
  // button + the main image link), and several layers of wrappers. The
  // visible card is usually 4-8 levels up from any individual link. We
  // walk up until we find a card-sized ancestor (at least ~180×180) and
  // mark THAT — marking the immediate parent hits a 0x0 wrapper.
  const main = document.querySelector('[role="main"]') || document.body;
  for (const link of main.querySelectorAll("a[href]")) {
    if (link.dataset.mwSponsoredChecked === "1") continue;

    let host;
    try {
      host = new URL(link.href, location.href).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (!host || host.endsWith("facebook.com") || host === "fb.com") continue;

    link.dataset.mwSponsoredChecked = "1";

    let el = link.parentElement;
    for (let depth = 0; depth < 12 && el; depth++, el = el.parentElement) {
      const r = el.getBoundingClientRect();
      if (r.width >= 180 && r.height >= 180) {
        el.dataset.mwSponsored = "1";
        break;
      }
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
        // Eagerly start scraping so the data is ready (or close to it) by
        // the time the user clicks Evaluate. Fire-and-forget; the queue
        // dedupes against any in-flight scrape.
        chrome.runtime
          .sendMessage({ type: "prefetch", listingId: id })
          .catch(() => {});
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
  if (cachedContexts[verdict.id]) badge.classList.add("mw-has-context");
  badge.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openContextPopup(verdict.id);
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
  const ctx = cachedContexts[verdict.id];
  if (ctx) lines.push(`\nUser notes:\n${ctx}`);
  lines.push("\n(right-click to add context / re-evaluate)");
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

  // Filter button wraps its popover so the popover can be absolutely
  // positioned relative to the button.
  const filterWrap = document.createElement("div");
  filterWrap.id = "mw-filter-wrap";
  const filter = document.createElement("button");
  filter.id = "mw-filter";
  filter.type = "button";
  filter.textContent = "Filter";
  filter.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleFilterPopover();
  });
  filterWrap.appendChild(filter);
  filterWrap.appendChild(buildFilterPopover());
  bar.appendChild(filterWrap);

  // Click anywhere outside the popover closes it.
  document.addEventListener("click", (e) => {
    const pop = document.getElementById("mw-filter-popover");
    if (!pop || !pop.classList.contains("mw-open")) return;
    if (filterWrap.contains(e.target)) return;
    toggleFilterPopover(false);
  });

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
  cachedContexts = {};
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

async function reEvaluateListing(id) {
  delete cachedVerdicts[id];
  // Drop both verdict and scraped cache so re-evaluation does a fresh
  // scrape — listing prices and descriptions can change. We deliberately
  // keep `context:{id}` so the user note carries forward into the new run.
  await chrome.storage.local.remove([`verdict:${id}`, `scraped:${id}`]);

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

// Right-click on a verdict badge opens this modal so the user can attach
// context (e.g. "rusty, kept outside") that will be appended to the
// description on the next analysis. Notes persist across re-analyses
// until cleared explicitly.
function openContextPopup(id) {
  // Don't stack popups.
  if (document.getElementById("mw-modal-backdrop")) return;

  const verdict = cachedVerdicts[id];
  const existing = cachedContexts[id] || "";

  const backdrop = document.createElement("div");
  backdrop.id = "mw-modal-backdrop";

  const modal = document.createElement("div");
  modal.id = "mw-modal";
  backdrop.appendChild(modal);

  const title = document.createElement("div");
  title.className = "mw-modal-title";
  title.textContent = "Add context";
  modal.appendChild(title);

  if (verdict?.title) {
    const sub = document.createElement("div");
    sub.className = "mw-modal-sub";
    sub.textContent = verdict.title;
    modal.appendChild(sub);
  }

  const hint = document.createElement("div");
  hint.className = "mw-modal-hint";
  hint.textContent =
    "Notes you add here are prepended to the listing description on re-analysis. Useful for visual cues from photos (e.g. \"rust on frame\", \"missing pedal\").";
  modal.appendChild(hint);

  const ta = document.createElement("textarea");
  ta.className = "mw-modal-textarea";
  ta.rows = 5;
  ta.value = existing;
  ta.placeholder = "e.g. bike looks rusty, probably kept outside in the rain";
  modal.appendChild(ta);

  const buttons = document.createElement("div");
  buttons.className = "mw-modal-buttons";
  modal.appendChild(buttons);

  const close = () => {
    backdrop.remove();
    document.removeEventListener("keydown", onKey);
  };

  const saveOnly = async () => {
    const next = ta.value.trim();
    if (next) {
      await chrome.storage.local.set({ [`context:${id}`]: next });
      cachedContexts[id] = next;
    } else if (existing) {
      await chrome.storage.local.remove(`context:${id}`);
      delete cachedContexts[id];
    }
    refreshAllOverlays();
  };

  const mkBtn = (label, cls, onClick) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `mw-modal-btn ${cls}`;
    b.textContent = label;
    b.addEventListener("click", onClick);
    buttons.appendChild(b);
    return b;
  };

  mkBtn("Cancel", "mw-modal-cancel", close);

  if (existing) {
    mkBtn("Clear", "mw-modal-clear", async () => {
      await chrome.storage.local.remove(`context:${id}`);
      delete cachedContexts[id];
      refreshAllOverlays();
      close();
    });
  }

  mkBtn("Save", "mw-modal-save", async () => {
    await saveOnly();
    close();
  });

  mkBtn("Save & Re-analyze", "mw-modal-primary", async () => {
    await saveOnly();
    close();
    reEvaluateListing(id);
  });

  // Backdrop click closes; clicks inside the modal don't bubble.
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  modal.addEventListener("click", (e) => e.stopPropagation());

  const onKey = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };
  document.addEventListener("keydown", onKey);

  document.body.appendChild(backdrop);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
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
  document.querySelectorAll("[data-mw-card]").forEach((el) => {
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
