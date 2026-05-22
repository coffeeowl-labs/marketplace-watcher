// content/search.js — runs on Marketplace search results pages.
// Adds a checkbox to each unevaluated card, a verdict badge to cached ones,
// and a floating Evaluate (N) button that batches 1-20 selected listings.

const HARD_CAP = 20;
const SOFT_FLOOR = 5;

// Per-listing selection. Absence = "None" (not in batch). "default" =
// in batch with no profile attached. Any other string = profile id from
// chrome.storage's `profiles` array. Replaces the v0 selectedIds Set;
// the per-card picker drives this. (The picker's "not in batch" option
// is labeled "None" rather than "Skip" because Skip is also a verdict
// state — colliding labels confused users in step-3 QA.)
const selections = new Map(); // listingId -> "default" | profileId
let cachedVerdicts = {}; // id -> verdict object
let cachedContexts = {}; // id -> user-provided context string
let currentProfiles = []; // [{id, name, prompt}]; mirrors chrome.storage.local.profiles
let openPicker = null;   // { card, id, btn, popover } | null — at most one popover open
// Listings the user has flagged as "Junk" via the picker. Persists across
// page reloads and is filtered out of the result list by default — main
// purpose is suppressing the same garbage listings Marketplace recycles
// across searches (e.g. a blown-head-gasket car that keeps reappearing in
// bike searches).
const junkedIds = new Set();
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
  { key: "junk", label: "Junk (hidden listings)" },
];

// All visible by default except sponsored + junk (nobody wants ads or
// already-rejected listings polluting their results). Persisted under
// `filter_visibility`. Toggling "junk" on is how a user un-junks a
// listing: junked cards reappear, picker shows "Junk" as current, pick
// anything else to undo.
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
  ensureFAB();
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

// React to profile edits in the Settings tab (or another Marketplace tab)
// without requiring a page reload. Demote selections that referenced a
// deleted profile to "default" and repaint any visible picker labels.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.profiles) {
    const next = Array.isArray(changes.profiles.newValue) ? changes.profiles.newValue : [];
    currentProfiles = next;
    const liveIds = new Set(next.map((p) => p.id));
    for (const [listingId, sel] of selections) {
      if (sel !== "default" && !liveIds.has(sel)) {
        selections.set(listingId, "default");
      }
    }
    for (const btn of document.querySelectorAll(".mw-picker")) {
      updatePickerLabel(btn, btn.dataset.mwId);
    }
    // Close any open popover — its option list is now stale.
    closeOpenPicker();
  }
  if (changes.junked_ids) {
    // Another tab junked or un-junked something; mirror in this tab.
    junkedIds.clear();
    const next = Array.isArray(changes.junked_ids.newValue) ? changes.junked_ids.newValue : [];
    for (const id of next) junkedIds.add(id);
    // Walk every overlay card and re-apply the data-mw-junk attribute.
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
      delete el.dataset.mwState;
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
      delete card.dataset.mwState;
      card.querySelectorAll(".mw-checkbox, .mw-badge").forEach((n) => n.remove());
    }
    card.dataset.mwCard = id;

    const cs = getComputedStyle(card);
    if (cs.position === "static") card.style.position = "relative";

    // Picker is always attached so users can change/re-evaluate even
    // after a verdict lands. Badge attaches on top when a verdict exists.
    attachPicker(card, id);
    if (cachedVerdicts[id]) {
      attachBadge(card, cachedVerdicts[id]);
    }
    applyJunkAttr(card, id);
  }
  // If FB recycled the card the open popover is anchored to, close it —
  // otherwise we leak a phantom dropdown layer.
  if (openPicker) {
    const stillThere = document.querySelector(`[data-mw-card="${openPicker.id}"]`);
    if (stillThere !== openPicker.card) closeOpenPicker();
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

// --- Per-card profile picker ----------------------------------------------
//
// Replaces the v0 checkbox. A custom button + popover (not a native
// <select>) because FB virtualizes its card list — a mid-open native
// select gets ripped out of the DOM with its dropdown still rendered,
// leaking a phantom layer. With our own popover we tear it down when
// the anchor card disappears (see attachOverlays above).

function attachPicker(card, id) {
  // attachOverlays may run more than once on the same card (mutations);
  // don't duplicate the picker.
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

  // Block clicks from bubbling to the card link.
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

  // Junk wins over selection — a junked listing displays "Junk" even if
  // it was previously in the batch (and selections will have been
  // cleared when we junked it). Surface this state explicitly so the
  // user knows what state they'll be acting against when re-opening the
  // popover via the "Show junked" filter toggle.
  if (junkedIds.has(id)) {
    labelEl.textContent = "Junk";
    btn.classList.add("mw-picker-junk");
    btn.title = "Hidden from view. Pick anything else to un-junk.";
    return;
  }

  const sel = selections.get(id);
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
    // Profile was deleted from storage while this listing was selected.
    // Silently demote to default — the storage.onChanged handler does
    // this for visible cards too, but a race can leave us here.
    selections.set(id, "default");
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
  const currentSel = selections.get(id); // undefined | "default" | profileId
  const addOption = (val, displayLabel, extraClass = "") => {
    const opt = document.createElement("button");
    opt.type = "button";
    opt.className = "mw-picker-option" + (extraClass ? " " + extraClass : "");
    opt.dataset.val = val;
    opt.textContent = displayLabel;
    opt.setAttribute("role", "menuitem");
    let isCurrent;
    if (val === "junk") isCurrent = isJunked;
    else if (isJunked) isCurrent = false; // junked listings have no batch state
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

  // Anchor under the button. The card already has position:relative
  // (set in attachOverlays for any non-static card), so absolute
  // positioning inside it is anchored correctly.
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

function handlePickerSelection(id, val) {
  if (val === "junk") {
    // Junking removes the listing from any batch state and hides it
    // (unless the user has the "Junk" filter toggled on, which is the
    // un-junk affordance).
    selections.delete(id);
    junkedIds.add(id);
    persistJunkedIds().catch(() => {});
  } else if (val === "none") {
    selections.delete(id);
    // Picking "None" on a junked listing un-junks it.
    if (junkedIds.delete(id)) persistJunkedIds().catch(() => {});
  } else {
    // Cap applies only when ADDING (changing an already-selected card's
    // profile shouldn't bump us over the cap).
    if (!selections.has(id) && selections.size >= HARD_CAP) {
      flashFAB("max 20 selected");
      closeOpenPicker();
      return;
    }
    selections.set(id, val);
    // Picking Default-or-a-profile on a junked listing also un-junks.
    if (junkedIds.delete(id)) persistJunkedIds().catch(() => {});
    // Eagerly scrape so the data is ready by the time the user clicks
    // Evaluate. Fire-and-forget; the queue dedupes against in-flight.
    chrome.runtime
      .sendMessage({ type: "prefetch", listingId: id })
      .catch(() => {});
  }

  // If the listing already has a verdict and the user is changing the
  // profile, treat that as "I want to redo this with the new profile" —
  // bust the verdict cache and remove the badge so the next Evaluate
  // re-runs this listing. Junk + None preserve the verdict (the cache
  // is still useful — un-junking should restore the badge).
  const hadVerdict = !!cachedVerdicts[id];
  const isProfileChange = val !== "none" && val !== "junk";
  if (hadVerdict && isProfileChange) {
    delete cachedVerdicts[id];
    chrome.storage.local.remove(`verdict:${id}`).catch(() => {});
    const card = document.querySelector(`[data-mw-card="${id}"]`);
    if (card) {
      card.querySelectorAll(".mw-badge").forEach((n) => n.remove());
      card.dataset.mwState = "unanalyzed";
    }
  }

  // Repaint the picker label + apply/remove the junk data attribute.
  const card = document.querySelector(`[data-mw-card="${id}"]`);
  if (card) {
    const btn = card.querySelector(".mw-picker");
    if (btn) updatePickerLabel(btn, id);
    applyJunkAttr(card, id);
  }
  closeOpenPicker();
  updateFAB();
}

// Document-level handlers — click-outside closes, Esc closes. Capture
// phase so we intercept clicks on FB's own elements before they navigate.
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

function attachBadge(card, verdict) {
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
  // Tooltip surfaces the full scraped payload alongside the verdict so
  // we can sanity-check what the model actually saw.
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
  if (verdict.images_included) {
    lines.push(`\nPhotos analyzed: ${verdict.image_count}`);
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

  const cancel = document.createElement("button");
  cancel.id = "mw-cancel";
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.hidden = true;
  cancel.addEventListener("click", onCancelClick);
  bar.appendChild(cancel);

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

// Shared in-flight guard for every code path that opens a location prompt.
// prompt() is supposed to be modal, but rapid clicks (especially via the FAB
// row) can still queue overlapping invocations across async hops — the guard
// keeps exactly one dialog on screen at a time and makes the Evaluate path
// short-circuit instead of opening a second prompt on top of the first.
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
      // Store raw only; background will geocode on next eval and persist lat/lng.
      await chrome.storage.local.set({ user_location: { raw: trimmed } });
    }
    refreshSetLocLabel();
  } finally {
    locationPromptOpen = false;
  }
}

// Returns true iff a non-empty user_location is in storage by the time the
// promise resolves. Callers MUST honor the false return — proceeding to
// analyze without a location loses distance/trip-cost adjustment and was
// the path users were accidentally taking by clicking Set Location and
// Evaluate in quick succession.
async function ensureUserLocation() {
  const stored = (await chrome.storage.local.get("user_location")).user_location;
  if (stored && stored.raw) return true;
  if (locationPromptOpen) return false;
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
  // Re-fetch profiles AFTER the clear — we just nuked them along with
  // everything else, which is the user's intent here.
  await chrome.storage.local.clear();
  cachedVerdicts = {};
  cachedContexts = {};
  currentProfiles = [];
  selections.clear();
  refreshAllOverlays();
  updateFAB();
}

function updateFAB() {
  const fab = document.getElementById("mw-fab");
  if (!fab) return;
  const n = selections.size;
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

async function reEvaluateListing(id, options = {}) {
  delete cachedVerdicts[id];
  // Drop both verdict and scraped cache so re-evaluation does a fresh
  // scrape — listing prices and descriptions can change. We deliberately
  // keep `context:{id}` so the user note carries forward into the new run.
  await chrome.storage.local.remove([`verdict:${id}`, `scraped:${id}`]);

  await ensureUserLocation();

  const fab = document.getElementById("mw-fab");
  fab.disabled = true;
  fab.textContent = options.includeImages
    ? "Re-evaluating with photos…"
    : "Re-evaluating…";

  try {
    const response = await chrome.runtime.sendMessage({
      type: "evaluate",
      listingIds: [id],
      options: { includeImages: !!options.includeImages },
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
async function openContextPopup(id) {
  // Don't stack popups.
  if (document.getElementById("mw-modal-backdrop")) return;

  const verdict = cachedVerdicts[id];
  const existing = cachedContexts[id] || "";

  // Image count comes from the cached scrape so we can label the checkbox
  // accurately. If the scrape predates the image-scrape feature, this is
  // undefined — treat as "unknown, will be attempted on re-scrape".
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
    "Notes you add here are prepended to the listing description on re-analysis. Useful for visual cues from photos (e.g. \"rust on frame\", \"missing pedal\").";
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
  // Hard gate: every verdict depends on distance/trip-cost reasoning, so
  // running without a location quietly degrades the analysis. Refuse and
  // flash the FAB instead of proceeding.
  const hasLocation = await ensureUserLocation();
  if (!hasLocation) {
    flashFAB("Set your location first");
    return;
  }
  fab.disabled = true;
  const ids = Array.from(selections.keys());
  // Build the per-listing profile mapping the background needs to attach
  // profile.{name,prompt} to each listing in the wire envelope. Skip
  // ("not in batch") never gets here because those ids aren't in
  // selections. "default" means "in batch, no profile" — omit from the
  // map so background sees no entry and doesn't attach a profile.
  const profileByListingId = {};
  for (const [listingId, sel] of selections) {
    if (sel && sel !== "default") profileByListingId[listingId] = sel;
  }
  fab.textContent = `Starting (${ids.length})…`;
  showCancelButton();

  try {
    const response = await chrome.runtime.sendMessage({
      type: "evaluate",
      listingIds: ids,
      profileByListingId,
    });
    if (!response) {
      fab.textContent = "Error: no response";
      setTimeout(updateFAB, 4000);
      return;
    }
    if (response.cancelled) {
      fab.textContent = "Cancelled";
      setTimeout(updateFAB, 2000);
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
    selections.clear();
    refreshAllOverlays();
    updateFAB();
  } catch (e) {
    fab.textContent = `Error: ${e.message}`;
    setTimeout(updateFAB, 5000);
  } finally {
    hideCancelButton();
  }
}

function showCancelButton() {
  const btn = document.getElementById("mw-cancel");
  if (btn) btn.hidden = false;
}

function hideCancelButton() {
  const btn = document.getElementById("mw-cancel");
  if (btn) btn.hidden = true;
}

async function onCancelClick() {
  const btn = document.getElementById("mw-cancel");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Cancelling…";
  }
  try {
    await chrome.runtime.sendMessage({ type: "cancel_evaluate" });
  } catch (_) {
    // Background may already have torn down; harmless.
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Cancel";
    }
  }
}

function refreshAllOverlays() {
  document.querySelectorAll("[data-mw-card]").forEach((el) => {
    el.removeAttribute("data-mw-card");
    delete el.dataset.mwState;
    el.querySelectorAll(".mw-checkbox, .mw-badge").forEach((n) => n.remove());
  });
  attachOverlays();
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "verdict_streamed") {
    onVerdictStreamed(msg.verdict, msg.done, msg.total);
    return;
  }
  if (msg.type !== "progress") return;
  const fab = document.getElementById("mw-fab");
  if (!fab) return;
  if (msg.phase === "fetching") {
    fab.textContent = `Fetching ${msg.done}/${msg.total}…`;
  } else if (msg.phase === "images") {
    fab.textContent = "Downloading photos…";
  } else if (msg.phase === "evaluating") {
    // Initial state before any verdicts have streamed back. Once
    // onVerdictStreamed starts firing it'll overwrite this with a
    // running count.
    fab.textContent = "Evaluating with Claude…";
  } else if (msg.phase === "done") {
    fab.textContent = "Done";
  } else if (msg.phase === "cancelled") {
    fab.textContent = "Cancelled";
    setTimeout(updateFAB, 2000);
    hideCancelButton();
  } else if (msg.phase === "error") {
    fab.textContent = `Error: ${msg.error}`;
  }
});

// Per-verdict streaming handler. Paint the badge on the matching card as
// soon as the verdict arrives so the user sees progress instead of a
// long opaque wait. The batch's final response (in onEvaluateClick)
// still runs refreshAllOverlays as a backstop for anything we missed.
function onVerdictStreamed(verdict, done, total) {
  if (!verdict || !verdict.id) return;
  cachedVerdicts[verdict.id] = verdict;
  selections.delete(verdict.id);
  const card = document.querySelector(`[data-mw-card="${verdict.id}"]`);
  if (card) {
    // Only the badge gets replaced — keep the picker in place so the
    // user can change profile + re-evaluate alongside the verdict.
    card.querySelectorAll(".mw-badge").forEach((n) => n.remove());
    attachBadge(card, verdict);
    // Picker label tracks `selections`, which we just deleted from, so
    // it'll show "None" again. Refresh it to reflect that.
    const btn = card.querySelector(".mw-picker");
    if (btn) updatePickerLabel(btn, verdict.id);
  }
  const fab = document.getElementById("mw-fab");
  if (fab && Number.isFinite(done) && Number.isFinite(total)) {
    fab.textContent = `Evaluating ${done}/${total}…`;
  }
}

function extractListingId(href) {
  const m = href.match(/\/marketplace\/item\/(\d+)/);
  return m ? m[1] : null;
}
