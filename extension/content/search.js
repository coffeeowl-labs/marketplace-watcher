// content/search.js — runs on Marketplace search results pages.
//
// Selection-triggers-everything model (no Analyze button). Picker change →
// batcher.commit() → 2s undo debounce → scrape → queued → ship in batches
// of 3-5 → claude → verdict. Auto-commit logic lives in batcher.js; this
// file is the UI side: picker, badges, Stop-all pill, location gate.

const HARD_CAP = 20;

let cachedVerdicts = {}; // id -> verdict object (from chrome.storage.local)
let cachedContexts = {}; // id -> user-provided context string
let currentProfiles = []; // [{id, name, prompt}]; mirrors chrome.storage.local.profiles
let openPicker = null;   // { card, id, btn, popover } | null — at most one popover open
// Listings the user has flagged as "Junk" via the picker. Persists across
// page reloads and is filtered out of the result list by default.
const junkedIds = new Set();
let mutationDebounceTimer = null;
// One-time-per-session prompt suppression so the user doesn't get a
// modal every time they pick a profile after dismissing it.
let locationPromptedThisSession = false;

// Display order of filter rows in the popover.
const FILTER_KINDS = [
  { key: "steal", label: "Steal" },
  { key: "good", label: "Good" },
  { key: "fair", label: "Fair" },
  { key: "skip", label: "Skip" },
  { key: "error", label: "Error" },
  { key: "unanalyzed", label: "Unanalyzed" },
  { key: "sponsored", label: "Sponsored / Ads" },
  { key: "junk", label: "Junk (hidden listings)" },
];

const filterState = {
  steal: true,
  good: true,
  fair: true,
  skip: true,
  error: true,
  unanalyzed: true,
  sponsored: false,
  junk: false,
};

(async () => {
  ({ verdicts: cachedVerdicts, contexts: cachedContexts } = await loadCachedData());
  await loadProfiles();
  MW_BATCHER.init({
    onChange: (id) => {
      const card = document.querySelector(`[data-mw-card="${id}"]`);
      if (card) renderCard(card, id);
      // QUEUED cards display "WAITING (N more)" text that depends on the
      // total queued count — when *any* entry transitions, re-render every
      // QUEUED card so the count stays accurate. Cost is O(queue size),
      // bounded at 20.
      for (const e of MW_BATCHER.snapshot()) {
        if (e.id === id) continue;
        if (e.state !== MW_BATCHER.STATES.QUEUED) continue;
        const c2 = document.querySelector(`[data-mw-card="${e.id}"]`);
        if (c2) renderCard(c2, e.id);
      }
      updateStopAllPill();
    },
  });
  ensureBar();
  await loadFilterState();
  setupObserver();
  attachOverlays();
})();

async function loadProfiles() {
  const data = await chrome.storage.local.get(["profiles", "junked_ids"]);
  currentProfiles = Array.isArray(data.profiles) ? data.profiles : [];
  junkedIds.clear();
  if (Array.isArray(data.junked_ids)) {
    for (const id of data.junked_ids) junkedIds.add(id);
  }
}

async function persistJunkedIds() {
  await chrome.storage.local.set({ junked_ids: Array.from(junkedIds) });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.profiles) {
    const next = Array.isArray(changes.profiles.newValue) ? changes.profiles.newValue : [];
    currentProfiles = next;
    // No selections map anymore — batcher.commit replaces it. If a
    // referenced profile got deleted, the batcher still has the id;
    // the ship-time profile resolution in background.js falls back to
    // "no profile" silently.
    for (const btn of document.querySelectorAll(".mw-picker")) {
      updatePickerLabel(btn, btn.dataset.mwId);
    }
    closeOpenPicker();
  }
  if (changes.junked_ids) {
    junkedIds.clear();
    const next = Array.isArray(changes.junked_ids.newValue) ? changes.junked_ids.newValue : [];
    for (const id of next) junkedIds.add(id);
    for (const card of document.querySelectorAll("[data-mw-card]")) {
      applyJunkAttr(card, card.dataset.mwCard);
    }
    for (const btn of document.querySelectorAll(".mw-picker")) {
      updatePickerLabel(btn, btn.dataset.mwId);
    }
  }
});

function applyJunkAttr(card, id) {
  if (junkedIds.has(id)) {
    card.dataset.mwJunk = "1";
  } else {
    delete card.dataset.mwJunk;
  }
}

async function loadFilterState() {
  const stored = await chrome.storage.local.get([
    "filter_visibility",
    "hide_skips", "hide_fair", "hide_good",
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
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["href"],
  });
}

function attachOverlays() {
  for (const el of document.querySelectorAll("[data-mw-card]")) {
    const inner = el.querySelector('a[href*="/marketplace/item/"]');
    const innerId = inner ? extractListingId(inner.getAttribute("href") || "") : null;
    if (innerId !== el.dataset.mwCard) {
      el.removeAttribute("data-mw-card");
      delete el.dataset.mwState;
      el.querySelectorAll(".mw-checkbox, .mw-badge").forEach((n) => n.remove());
    }
  }

  const links = document.querySelectorAll('a[href*="/marketplace/item/"]');
  for (const link of links) {
    const id = extractListingId(link.getAttribute("href") || "");
    if (!id) continue;
    const card = link.parentElement || link;
    if (card.dataset.mwCard === id) continue;
    if (card.dataset.mwCard) {
      delete card.dataset.mwState;
      card.querySelectorAll(".mw-checkbox, .mw-badge").forEach((n) => n.remove());
    }
    card.dataset.mwCard = id;

    const cs = getComputedStyle(card);
    if (cs.position === "static") card.style.position = "relative";

    attachPicker(card, id);
    renderCard(card, id);
    applyJunkAttr(card, id);
  }
  if (openPicker) {
    const stillThere = document.querySelector(`[data-mw-card="${openPicker.id}"]`);
    if (stillThere !== openPicker.card) closeOpenPicker();
  }
  markSponsoredCards();
}

function markSponsoredCards() {
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

// --- Per-card profile picker ----------------------------------------------

function attachPicker(card, id) {
  if (card.querySelector(".mw-picker")) {
    updatePickerLabel(card.querySelector(".mw-picker"), id);
    return;
  }
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "mw-picker";
  btn.dataset.mwId = id;
  btn.setAttribute("aria-haspopup", "true");
  btn.setAttribute("aria-expanded", "false");

  const label = document.createElement("span");
  label.className = "mw-picker-label";
  const caret = document.createElement("span");
  caret.className = "mw-picker-caret";
  caret.textContent = "▾";
  btn.append(label, caret);

  btn.addEventListener("mousedown", (e) => e.stopPropagation());
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    togglePicker(card, id, btn);
  });

  card.dataset.mwState ||= "unanalyzed";
  card.appendChild(btn);
  updatePickerLabel(btn, id);
}

function updatePickerLabel(btn, id) {
  const labelEl = btn.querySelector(".mw-picker-label");
  btn.classList.remove("mw-picker-active", "mw-picker-profile", "mw-picker-junk");

  if (junkedIds.has(id)) {
    labelEl.textContent = "Junk";
    btn.classList.add("mw-picker-junk");
    btn.title = "Hidden from view. Pick anything else to un-junk.";
    return;
  }

  // Active selection lives in the batcher entry for transient states; if
  // there's no entry, the picker shows "None".
  const entry = MW_BATCHER.getEntry(id);
  const sel = entry ? entry.profileId : null;
  if (!sel) {
    labelEl.textContent = "None";
    btn.title = "Click to add this listing to the batch.";
    return;
  }
  btn.classList.add("mw-picker-active");
  if (sel === "default") {
    labelEl.textContent = "Default";
    btn.title = "Will be evaluated without any profile criteria.";
    return;
  }
  const profile = currentProfiles.find((p) => p.id === sel);
  labelEl.textContent = profile ? profile.name : "Default";
  if (profile) {
    btn.classList.add("mw-picker-profile");
    btn.title = `Will be evaluated against profile: ${profile.name}.`;
  } else {
    btn.title = "Selected profile was removed; will use default.";
  }
}

function togglePicker(card, id, btn) {
  if (openPicker && openPicker.id === id) {
    closeOpenPicker();
    return;
  }
  closeOpenPicker();

  const popover = document.createElement("div");
  popover.className = "mw-picker-popover";
  popover.setAttribute("role", "menu");

  const isJunked = junkedIds.has(id);
  const entry = MW_BATCHER.getEntry(id);
  const currentSel = entry ? entry.profileId : undefined;

  const addOption = (val, displayLabel, extraClass = "") => {
    const opt = document.createElement("button");
    opt.type = "button";
    opt.className = "mw-picker-option" + (extraClass ? " " + extraClass : "");
    opt.dataset.val = val;
    opt.textContent = displayLabel;
    opt.setAttribute("role", "menuitem");
    let isCurrent;
    if (val === "junk") isCurrent = isJunked;
    else if (isJunked) isCurrent = false;
    else if (val === "none") isCurrent = currentSel === undefined;
    else isCurrent = val === currentSel;
    if (isCurrent) opt.classList.add("mw-picker-option-current");
    opt.addEventListener("mousedown", (e) => e.stopPropagation());
    opt.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      handlePickerSelection(id, val);
    });
    popover.appendChild(opt);
  };
  const addDivider = () => {
    const d = document.createElement("div");
    d.className = "mw-picker-divider";
    popover.appendChild(d);
  };

  addOption("none", "None");
  addOption("default", "Evaluate (default)");
  if (currentProfiles.length > 0) {
    addDivider();
    for (const p of currentProfiles) addOption(p.id, p.name);
  }
  addDivider();
  addOption("junk", "Junk (hide)", "mw-picker-option-junk");

  popover.style.position = "absolute";
  popover.style.top = `${btn.offsetTop + btn.offsetHeight + 4}px`;
  popover.style.left = `${btn.offsetLeft}px`;
  card.appendChild(popover);
  btn.setAttribute("aria-expanded", "true");
  openPicker = { card, id, btn, popover };
}

function closeOpenPicker() {
  if (!openPicker) return;
  try {
    openPicker.popover.remove();
    openPicker.btn.setAttribute("aria-expanded", "false");
  } catch (_) {}
  openPicker = null;
}

async function handlePickerSelection(id, val) {
  closeOpenPicker();

  if (val === "junk") {
    MW_BATCHER.cancel(id);
    junkedIds.add(id);
    persistJunkedIds().catch(() => {});
    repaintCardAndPicker(id);
    return;
  }
  if (val === "none") {
    MW_BATCHER.cancel(id);
    if (junkedIds.delete(id)) persistJunkedIds().catch(() => {});
    repaintCardAndPicker(id);
    return;
  }

  // Adding (default or profile). Apply the 20-cap if this id isn't already
  // in flight.
  if (!MW_BATCHER.getEntry(id) && MW_BATCHER.activeCount() >= HARD_CAP) {
    flashStopAll(`max ${HARD_CAP} in flight`);
    return;
  }

  // Location gate. Hard requirement — trip-cost reasoning depends on it.
  // Prompted at most once per session; subsequent commits without location
  // surface the requirement as an error badge on the affected card.
  const hasLocation = await ensureUserLocationOnce();
  if (!hasLocation) {
    flashStopAll("Set your location first");
    return;
  }

  if (junkedIds.delete(id)) persistJunkedIds().catch(() => {});

  // If there's a cached verdict and the user is committing a new run, drop
  // the cached verdict + scraped cache so a fresh scrape + evaluation runs.
  // (The batcher will request a scrape; without busting the cache it'd
  // reuse stale data.)
  if (cachedVerdicts[id]) {
    delete cachedVerdicts[id];
    chrome.storage.local.remove([`verdict:${id}`, `scraped:${id}`]).catch(() => {});
  }

  MW_BATCHER.commit(id, val);
  repaintCardAndPicker(id);
}

function repaintCardAndPicker(id) {
  const card = document.querySelector(`[data-mw-card="${id}"]`);
  if (!card) return;
  const btn = card.querySelector(".mw-picker");
  if (btn) updatePickerLabel(btn, id);
  applyJunkAttr(card, id);
  renderCard(card, id);
  updateStopAllPill();
}

document.addEventListener(
  "click",
  (e) => {
    if (!openPicker) return;
    if (openPicker.popover.contains(e.target)) return;
    if (openPicker.btn.contains(e.target)) return;
    closeOpenPicker();
  },
  true
);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && openPicker) {
    e.preventDefault();
    closeOpenPicker();
  }
});

// --- Card rendering -------------------------------------------------------
//
// Renders both the transient batcher state (pending-undo / scraping /
// queued / evaluating / error) and the final verdict badge. Replaces the
// previous attachBadge — the renderer is now state-driven so the badge
// can update on every transition.

function renderCard(card, id) {
  // Strip any existing badge; we re-render from scratch.
  card.querySelectorAll(".mw-badge").forEach((n) => n.remove());

  const entry = MW_BATCHER.getEntry(id);
  const verdict = cachedVerdicts[id];

  // Transient batcher states take precedence over the cached verdict.
  if (entry) {
    const s = entry.state;
    if (s === MW_BATCHER.STATES.PENDING_UNDO ||
        s === MW_BATCHER.STATES.SCRAPING ||
        s === MW_BATCHER.STATES.QUEUED ||
        s === MW_BATCHER.STATES.EVALUATING ||
        s === MW_BATCHER.STATES.ERROR) {
      attachTransientBadge(card, id, entry);
      return;
    }
    // DONE falls through to the verdict-from-cache rendering below; the
    // verdict_streamed listener already wrote the verdict to storage.
  }

  if (verdict) {
    attachVerdictBadge(card, verdict);
  } else {
    card.dataset.mwState = "unanalyzed";
  }
}

function attachTransientBadge(card, id, entry) {
  const badge = document.createElement("div");
  badge.className = "mw-badge mw-transient";
  badge.setAttribute("aria-live", "polite");

  const s = entry.state;
  if (s === MW_BATCHER.STATES.PENDING_UNDO) {
    badge.classList.add("mw-pending");
    badge.textContent = "QUEUING…";
    badge.title = "Will start in 2s. Pick None/Junk to cancel.";
    card.dataset.mwState = "pending";
  } else if (s === MW_BATCHER.STATES.SCRAPING) {
    badge.classList.add("mw-scraping");
    badge.textContent = "FETCHING";
    badge.title = "Scraping the listing page for full description + photos.";
    card.dataset.mwState = "scraping";
  } else if (s === MW_BATCHER.STATES.QUEUED) {
    const queued = MW_BATCHER.countByState().queued;
    if (queued < MW_BATCHER.MIN_BATCH) {
      badge.classList.add("mw-waiting");
      const need = MW_BATCHER.MIN_BATCH - queued;
      badge.textContent = `WAITING (${need} more)`;
      badge.title =
        `Need ${MW_BATCHER.MIN_BATCH} listings before evaluation runs. ` +
        `Comparison between listings is the point of the tool — solo runs aren't useful.`;
    } else {
      badge.classList.add("mw-queued");
      badge.textContent = "QUEUED";
      badge.title = "Batched and ready to ship.";
    }
    card.dataset.mwState = "queued";
  } else if (s === MW_BATCHER.STATES.EVALUATING) {
    badge.classList.add("mw-evaluating");
    badge.textContent = "EVALUATING";
    badge.title = "Claude is reasoning about this listing.";
    card.dataset.mwState = "evaluating";
  } else if (s === MW_BATCHER.STATES.ERROR) {
    badge.classList.add("mw-error");
    badge.textContent = "ERR";
    badge.title = entry.errorMessage || "Evaluation failed";
    card.dataset.mwState = "error";
  }
  card.appendChild(badge);
}

function attachVerdictBadge(card, verdict) {
  const badge = document.createElement("div");
  const v = verdict.verdict || "error";
  badge.className = `mw-badge mw-${v}`;
  card.dataset.mwState = v;
  badge.textContent = (verdict.error ? "ERR" : v).toUpperCase();
  if (cachedContexts[verdict.id]) badge.classList.add("mw-has-context");
  badge.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openContextPopup(verdict.id);
  });
  const lines = [];
  if (verdict.profile_name) lines.push(`EVALUATED AS: ${verdict.profile_name}`);
  if (verdict.reason) lines.push(`REASON: ${verdict.reason}`);
  if (verdict.error) lines.push(`ERROR: ${verdict.error}`);
  if (verdict.title) lines.push(`\nTitle: ${verdict.title}`);
  if (verdict.price) lines.push(`Price: ${verdict.price}`);
  if (verdict.location) lines.push(`Location: ${verdict.location}`);
  if (verdict.distance_miles != null) {
    const gas = verdict.round_trip_gas_cost ?? 0;
    const time = verdict.round_trip_time_cost ?? 0;
    const mins = verdict.drive_time_one_way_min ?? 0;
    lines.push(`Distance: ${verdict.distance_miles} mi (~${mins} min one way)`);
    lines.push(
      `Round-trip cost: $${gas.toFixed(2)} gas + $${time.toFixed(2)} time = $${(gas + time).toFixed(2)}`
    );
  }
  if (verdict.description) {
    const d = verdict.description;
    lines.push(`\nDescription (${d.length} chars):\n${d.slice(0, 600)}${d.length > 600 ? "…" : ""}`);
  }
  if (verdict.images_included) {
    lines.push(`\nPhotos analyzed: ${verdict.image_count}`);
  }
  const ctx = cachedContexts[verdict.id];
  if (ctx) lines.push(`\nUser notes:\n${ctx}`);
  lines.push("\n(right-click to add context / re-evaluate)");
  badge.title = lines.join("\n");
  card.appendChild(badge);
}

// --- Bar (Set Location / Filter / Stop All / Clear Cache) -----------------

function ensureBar() {
  if (document.getElementById("mw-bar")) return;
  const bar = document.createElement("div");
  bar.id = "mw-bar";

  const stopAll = document.createElement("button");
  stopAll.id = "mw-stop-all";
  stopAll.type = "button";
  stopAll.textContent = "Stop All";
  stopAll.hidden = true;
  stopAll.addEventListener("click", () => MW_BATCHER.stopAll());
  bar.appendChild(stopAll);

  const setLoc = document.createElement("button");
  setLoc.id = "mw-setloc";
  setLoc.type = "button";
  setLoc.textContent = "Set Location";
  setLoc.addEventListener("click", onSetLocationClick);
  bar.appendChild(setLoc);

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
  refreshSetLocLabel();
}

function updateStopAllPill() {
  const btn = document.getElementById("mw-stop-all");
  if (!btn) return;
  const c = MW_BATCHER.countByState();
  // Visible whenever there's anything user-cancellable in flight.
  const anyInFlight = c.pending + c.scraping + c.queued + c.evaluating > 0;
  btn.hidden = !anyInFlight;
}

function flashStopAll(text) {
  // No FAB anymore — flash a transient label on the Stop-all pill (or
  // create a transient pill if none is visible).
  let pill = document.getElementById("mw-stop-all");
  if (!pill) return;
  const wasHidden = pill.hidden;
  const prev = pill.textContent;
  pill.hidden = false;
  pill.textContent = text;
  pill.classList.add("mw-flash");
  setTimeout(() => {
    pill.textContent = prev;
    pill.classList.remove("mw-flash");
    if (wasHidden) pill.hidden = true;
    updateStopAllPill();
  }, 1500);
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

let locationPromptOpen = false;

async function onSetLocationClick() {
  if (locationPromptOpen) return;
  locationPromptOpen = true;
  try {
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
      await chrome.storage.local.set({ user_location: { raw: trimmed } });
    }
    refreshSetLocLabel();
  } finally {
    locationPromptOpen = false;
  }
}

// Returns true iff a non-empty user_location is in storage. Prompts at
// most once per tab session; further commits without location surface as
// per-card ERROR badges so the user can recover via the Set Location button.
async function ensureUserLocationOnce() {
  const stored = (await chrome.storage.local.get("user_location")).user_location;
  if (stored && stored.raw) return true;
  if (locationPromptedThisSession) return false;
  if (locationPromptOpen) return false;
  locationPromptedThisSession = true;
  locationPromptOpen = true;
  try {
    const input = prompt(
      "Set your location to enable distance / trip-cost analysis.\n\nEnter a ZIP code, city, or address (or press Cancel to skip):"
    );
    if (input === null || !input.trim()) return false;
    await chrome.storage.local.set({ user_location: { raw: input.trim() } });
    refreshSetLocLabel();
    return true;
  } finally {
    locationPromptOpen = false;
  }
}

async function onClearCacheClick() {
  const count = Object.keys(cachedVerdicts).length;
  if (!confirm(`Clear ${count} cached verdict${count === 1 ? "" : "s"}?`)) return;
  await chrome.storage.local.clear();
  cachedVerdicts = {};
  cachedContexts = {};
  currentProfiles = [];
  MW_BATCHER.stopAll();
  refreshAllOverlays();
  updateStopAllPill();
}

// --- Re-evaluate from the right-click context modal -----------------------
// Bypasses the batcher: this is a deliberate single-listing action with
// includeImages semantics. Ships one item directly via ship_batch.

async function reEvaluateListing(id, options = {}) {
  delete cachedVerdicts[id];
  await chrome.storage.local.remove([`verdict:${id}`, `scraped:${id}`]);

  const hasLocation = await ensureUserLocationOnce();
  if (!hasLocation) {
    flashStopAll("Set your location first");
    return;
  }

  // Paint an evaluating placeholder so the user sees the transition. The
  // verdict_streamed listener will replace it when claude returns.
  const card = document.querySelector(`[data-mw-card="${id}"]`);
  if (card) {
    card.querySelectorAll(".mw-badge").forEach((n) => n.remove());
    const badge = document.createElement("div");
    badge.className = "mw-badge mw-transient mw-evaluating";
    badge.textContent = options.includeImages ? "RE-EVAL (PHOTOS)" : "RE-EVAL";
    badge.title = "Re-running claude with the latest scrape.";
    card.appendChild(badge);
    card.dataset.mwState = "evaluating";
  }

  try {
    await chrome.runtime.sendMessage({
      type: "ship_batch",
      requestId: crypto.randomUUID(),
      items: [{ id, profileId: "default" }],
      includeImages: !!options.includeImages,
    });
  } catch (e) {
    // Re-paint with an error badge if the ship itself failed (rare).
    if (card) {
      card.querySelectorAll(".mw-badge").forEach((n) => n.remove());
      const badge = document.createElement("div");
      badge.className = "mw-badge mw-transient mw-error";
      badge.textContent = "ERR";
      badge.title = e.message || "Re-evaluate failed";
      card.appendChild(badge);
      card.dataset.mwState = "error";
    }
  }
}

// Right-click on a verdict badge opens this modal so the user can attach
// context (e.g. "rusty, kept outside") and optionally re-run with photos.
async function openContextPopup(id) {
  if (document.getElementById("mw-modal-backdrop")) return;

  const verdict = cachedVerdicts[id];
  const existing = cachedContexts[id] || "";

  const scrapedKey = `scraped:${id}`;
  const scrapedRecord = (await chrome.storage.local.get(scrapedKey))[scrapedKey];
  const imageCount = Array.isArray(scrapedRecord?.images)
    ? scrapedRecord.images.length
    : null;

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
    "Notes you add here are prepended to the listing description on re-analysis. " +
    "Useful for visual cues from photos (e.g. \"rust on frame\", \"missing pedal\").";
  modal.appendChild(hint);

  const ta = document.createElement("textarea");
  ta.className = "mw-modal-textarea";
  ta.rows = 5;
  ta.value = existing;
  ta.placeholder = "e.g. bike looks rusty, probably kept outside in the rain";
  modal.appendChild(ta);

  const imageRow = document.createElement("label");
  imageRow.className = "mw-modal-image-row";
  const imageCb = document.createElement("input");
  imageCb.type = "checkbox";
  imageCb.checked = false;
  const imageLabel = document.createElement("span");
  if (imageCount === 0) {
    imageRow.classList.add("mw-disabled");
    imageCb.disabled = true;
    imageLabel.textContent = "No photos detected on this listing";
  } else if (imageCount == null) {
    imageLabel.textContent =
      "Include photos in re-analysis (count unknown — will attempt to fetch)";
  } else {
    imageLabel.textContent = `Include photos in re-analysis (${imageCount} detected)`;
  }
  imageRow.appendChild(imageCb);
  imageRow.appendChild(imageLabel);
  modal.appendChild(imageRow);

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
    const includeImages = imageCb.checked;
    await saveOnly();
    close();
    reEvaluateListing(id, { includeImages });
  });

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

function refreshAllOverlays() {
  document.querySelectorAll("[data-mw-card]").forEach((el) => {
    el.removeAttribute("data-mw-card");
    delete el.dataset.mwState;
    el.querySelectorAll(".mw-checkbox, .mw-badge").forEach((n) => n.remove());
  });
  attachOverlays();
}

// --- Messages from background --------------------------------------------

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "verdict_streamed") {
    onVerdictStreamed(msg.verdict);
    return;
  }
  if (msg.type === "batch_done") {
    MW_BATCHER.handleBatchDone(msg.requestId, msg.error || null);
    updateStopAllPill();
    return;
  }
});

function onVerdictStreamed(verdict) {
  if (!verdict || !verdict.id) return;
  cachedVerdicts[verdict.id] = verdict;
  // handleVerdict is a no-op for re-evaluate (no batcher entry); for
  // batcher-path verdicts it transitions to DONE and emits via onChange.
  // Either way, we re-render the card explicitly so the badge updates.
  MW_BATCHER.handleVerdict(verdict);
  const card = document.querySelector(`[data-mw-card="${verdict.id}"]`);
  if (card) {
    renderCard(card, verdict.id);
    const btn = card.querySelector(".mw-picker");
    if (btn) updatePickerLabel(btn, verdict.id);
  }
}

function extractListingId(href) {
  const m = href.match(/\/marketplace\/item\/(\d+)/);
  return m ? m[1] : null;
}
