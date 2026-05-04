// content/listing.js — runs on /marketplace/item/<id>/ pages.
// Waits for the React-rendered listing data, scrapes it, reports back.
//
// FB uses obfuscated class names so we identify fields by structure and text:
//   - title:    <h1>
//   - price:    first currency-formatted text in main
//   - description: text following a "Description" header in main, bounded by
//                  the next major section header
//   - location: text matching "City, ST" or "City, Country"

// Per-page log buffer. Every mwLog call sends to background AND appends here
// so we can attach it to the final scraped message — guarantees we don't lose
// diagnostics if the tab closes before the relay flush completes.
const PAGE_LOG = [];
const PAGE_TRACE_ID = `scrape-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

let _entrySeq = 0;
function mwLog(category, level, data = {}) {
  const entry = {
    // entryId lets background dedupe between the live relay and the embedded
    // diagnostics backup we attach to the scraped message.
    entryId: `${PAGE_TRACE_ID}#${++_entrySeq}`,
    ts: Date.now(),
    src: "listing",
    traceId: PAGE_TRACE_ID,
    category,
    level: level || "debug",
    pathname: location.pathname,
    ...data,
  };
  PAGE_LOG.push(entry);
  try {
    chrome.runtime.sendMessage({ type: "log", entry }).catch(() => {});
  } catch (e) {
    // sendMessage can throw synchronously if the runtime is gone.
  }
}

(async () => {
  const listingId = extractListingId(location.pathname);
  if (!listingId) return;

  // Try to expand the description if FB collapsed it behind "See more"
  await clickSeeMoreIfPresent();

  const data = await waitForListingData();
  // Embed buffered diagnostics so the background can persist them even if
  // the in-flight runtime.sendMessage relays were lost when this tab closed.
  chrome.runtime.sendMessage({
    type: "scraped",
    listingId,
    data,
    diagnostics: PAGE_LOG.slice(),
  });
})();

function extractListingId(path) {
  const m = path.match(/\/marketplace\/item\/(\d+)/);
  return m ? m[1] : null;
}

async function waitForListingData(maxWaitMs = 8000) {
  // Wait for the Details-section structural scrape to succeed. 8s is enough
  // for a typical FB render even on cold tabs; if the Details h2 isn't there
  // by then, it's almost certainly never coming and we should fail fast so
  // the batch finishes instead of stalling 15s per bad listing.
  const start = Date.now();
  let last = null;
  while (Date.now() - start < maxWaitMs) {
    const data = tryScrape();
    if (data.title && data.price && data.description) return data;
    last = data;
    await sleep(500);
  }
  // Exhausted. Dump a forensic snapshot of all section-header-like text on
  // the page so we can see what FB is actually labeling things as for this
  // listing (vehicles, certain categories, or empty-desc cases may use
  // different markup than the literal text "Description").
  const final = tryScrape();
  dumpStructuralDiagnostics();
  mwLog("scrape_window_exhausted", "warn", {
    title: final.title,
    price: final.price,
    descLen: (final.description || "").length,
  });
  return final.description ? final : last || final;
}

function dumpStructuralDiagnostics() {
  const main = document.querySelector('[role="main"]') || document.body;
  const headings = [];
  for (const el of main.querySelectorAll("h1, h2, h3, h4, [role='heading']")) {
    const t = (el.innerText || "").trim();
    if (t) headings.push({
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") || null,
      ariaLevel: el.getAttribute("aria-level") || null,
      text: t.slice(0, 120),
    });
  }
  // Anything with the literal word "description" anywhere — even inside a
  // multi-child wrapper that our exact-match candidate filter rejects.
  const descMentions = [];
  for (const el of main.querySelectorAll("span, div, h2, h3, strong, b")) {
    const t = (el.innerText || "").trim();
    if (!t || t.length > 80) continue;
    if (/description/i.test(t)) {
      descMentions.push({
        tag: el.tagName.toLowerCase(),
        childCount: el.children.length,
        text: t.slice(0, 120),
      });
    }
  }

  // Same descMention scan but document-wide — catches the case where FB
  // renders the description label outside <main role="main">.
  const docDescMentions = [];
  for (const el of document.body.querySelectorAll("span, div, h2, h3, strong, b")) {
    const t = (el.innerText || "").trim();
    if (!t || t.length > 80) continue;
    if (/description/i.test(t)) {
      docDescMentions.push({
        tag: el.tagName.toLowerCase(),
        childCount: el.children.length,
        text: t.slice(0, 120),
        inMain: main.contains(el),
      });
    }
  }

  // DOM neighborhood around the h1: walk up 4 ancestors, dump the immediate
  // children of each. The description should sit somewhere in this
  // structural neighborhood; logging it lets us see what label/markup FB
  // is actually using when "Description" isn't a literal text node.
  const h1 = main.querySelector("h1");
  const neighborhood = [];
  if (h1) {
    let node = h1;
    for (let level = 0; level < 4 && node?.parentElement; level++) {
      const parent = node.parentElement;
      const children = [];
      for (const child of parent.children) {
        const t = (child.innerText || "").trim();
        children.push({
          tag: child.tagName.toLowerCase(),
          isH1Branch: child === node,
          textLen: t.length,
          textHead: t.slice(0, 200),
        });
      }
      neighborhood.push({
        level,
        parentTag: parent.tagName.toLowerCase(),
        parentRole: parent.getAttribute("role") || null,
        childCount: parent.children.length,
        children: children.slice(0, 20),
      });
      node = parent;
    }
  }

  // Census of all leaf-text blocks on the page so we can see, by length,
  // where the actual description text lives even if it has no label.
  // Long leaf-text elements are uncommon — typically the description is one
  // of the longest entries in this list.
  const leafTexts = [];
  for (const el of main.querySelectorAll("span, div, p")) {
    if (el.children.length !== 0) continue;
    const t = (el.innerText || "").trim();
    if (t.length < 30) continue;
    leafTexts.push({
      tag: el.tagName.toLowerCase(),
      len: t.length,
      text: t.slice(0, 200),
    });
  }
  leafTexts.sort((a, b) => b.len - a.len);

  // Shadow DOM smoke check. If FB starts using Shadow DOM in this region,
  // querySelectorAll won't see inside it and we'd see "nothing is here"
  // with no other clue why — flag it explicitly.
  let shadowRootCount = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  while (walker.nextNode()) {
    if (walker.currentNode.shadowRoot) shadowRootCount++;
  }

  const fullText = main.innerText || "";
  mwLog("structural_dump", "warn", {
    fullTextLen: fullText.length,
    // Bumped from 600 → 5000. The description is often deep on the page;
    // a small head sample misses it. 5000 chars is ~3KB JSON, still fine.
    fullTextStart: fullText.slice(0, 5000),
    headingCount: headings.length,
    headings: headings.slice(0, 30),
    descMentionsInMain: descMentions.length,
    descMentions: descMentions.slice(0, 20),
    descMentionsInDoc: docDescMentions.length,
    docDescMentions: docDescMentions.slice(0, 20),
    h1Neighborhood: neighborhood,
    longestLeafTexts: leafTexts.slice(0, 15),
    shadowRootCount,
  });
}

async function clickSeeMoreIfPresent() {
  // Wait briefly for the page to render before looking
  await sleep(1500);
  const buttons = document.querySelectorAll(
    'div[role="button"], span[role="button"], button'
  );
  for (const btn of buttons) {
    const txt = (btn.innerText || "").trim();
    if (/^see more$/i.test(txt)) {
      btn.click();
      await sleep(400);
      return;
    }
  }
}

// Strategy notes (validated by structural_dump diagnostics 2026-05-03):
// FB Marketplace listing pages do NOT have a "Description" header. They
// use one of two section schemas (sometimes both):
//   - "Details" h2 — contains structured field pairs (Condition / value)
//     followed by the seller's free text and a location footer.
//   - "Seller's description" h2 — contains the seller's free text
//     directly, no structured fields, then the location footer.
// We anchor on whichever h2 we find first after the h1, take everything
// up to the next h2 boundary (typically "Seller information"), then
// strip known field/value pairs, the location footer, and the
// "See more"/"See less" expand toggle text. What remains is the
// description.
//
// This replaces the previous DESCRIPTION_RE regex that searched for a
// literal "Description\n" label which never existed in FB's markup —
// the longest-block fallback was the only thing actually working, and
// it grabbed adjacent recommendation cards or ads when those were
// longer than the real description.

// h2 texts that mark the start of the description section.
const DESCRIPTION_SECTION_HEADINGS = new Set([
  "Details",
  "Seller's description",
]);

// Field labels FB renders inside the Details section as "label\nvalue"
// pairs. Each label and the line immediately following it should be
// stripped before what's left is treated as the seller's free-form text.
const DETAILS_FIELD_LABELS = new Set([
  "Condition",
  "Year", "Make", "Model", "Trim",
  "Mileage", "Transmission", "Fuel type", "Drive type",
  "Body style", "Body type",
  "Exterior color", "Interior color",
  "VIN", "Title status",
  "Engine", "Cylinders",
]);

// City, ST or City, State pattern marking the location footer at the
// bottom of the Details block.
const LOCATION_LINE_RE = /^[A-Z][a-zA-Z .'-]+(?:, [A-Z][a-zA-Z .'-]+)?,\s*(?:[A-Z]{2}|[A-Z][a-zA-Z]+)$/;

const NON_DESCRIPTION_LINES = new Set([
  "Location is approximate",
  "Location is hidden",
  "Send seller a message",
  "Send",
  "Save",
  "Share",
  "SaveShare",
  "Message",
]);

function extractDescription(main, h1) {
  if (!h1) return { description: "", descriptionSource: "no-h1" };

  const h2s = Array.from(main.querySelectorAll("h2"));
  // First h2 after h1 whose text is one of our known anchors.
  const sectionH2 = h2s.find((h) => {
    const t = (h.innerText || "").trim();
    if (!DESCRIPTION_SECTION_HEADINGS.has(t)) return false;
    const pos = h1.compareDocumentPosition(h);
    return !!(pos & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  if (!sectionH2) return { description: "", descriptionSource: "no-section-h2" };

  const sectionLabel = (sectionH2.innerText || "").trim();

  // Boundary: the next h2 after our anchor (typically "Seller information").
  // If none exists, take to end of main.
  const nextH2 = h2s.find((h) => {
    const pos = sectionH2.compareDocumentPosition(h);
    return !!(pos & Node.DOCUMENT_POSITION_FOLLOWING);
  });

  let rawText;
  try {
    const range = document.createRange();
    range.setStartAfter(sectionH2);
    if (nextH2) range.setEndBefore(nextH2);
    else range.setEndAfter(main);
    rawText = range.toString();
  } catch (e) {
    return { description: "", descriptionSource: "range-failed" };
  }

  const cleaned = stripDetailsBoilerplate(rawText);
  return cleaned
    ? { description: cleaned, descriptionSource: `section:${sectionLabel}` }
    : { description: "", descriptionSource: "section-empty-after-strip" };
}

function stripDetailsBoilerplate(rawText) {
  const lines = rawText.split("\n").map((l) => l.trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    // FB renders the description with a "See more"/"See less" toggle
    // appended to the last visible line. Strip it from anywhere it lands
    // (suffix on a line is the common case; standalone is the rare case).
    line = line.replace(/\s*(?:See more|See less)\s*$/i, "").trim();
    if (!line) continue;
    // "Field label\nvalue" pair — skip both lines.
    if (DETAILS_FIELD_LABELS.has(line)) {
      i++; // skip the value
      continue;
    }
    if (NON_DESCRIPTION_LINES.has(line)) continue;
    if (LOCATION_LINE_RE.test(line)) continue;
    out.push(line);
  }
  return out.join("\n").trim();
}

function describeEl(el) {
  if (!el) return "null";
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : "";
  const cls = el.className && typeof el.className === "string"
    ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}`
    : "";
  let depth = 0;
  for (let p = el.parentElement; p; p = p.parentElement) depth++;
  return `${tag}${id}${cls}@d${depth}`;
}

function tryScrape() {
  const main = document.querySelector('[role="main"]') || document.body;
  const fullText = main.innerText || "";

  const allH1s = main.querySelectorAll("h1");

  // The first <h1> on the page belongs to FB's chrome (e.g. "Notifications").
  // Scope to the main content region; fall back to <title> with the
  // "Marketplace - " prefix stripped.
  const h1 = main.querySelector("h1");
  let title = h1?.innerText?.trim() || "";
  if (!title || title === "Notifications") {
    const docTitle = (document.title || "").trim();
    title = docTitle.replace(/^Marketplace\s*[-–|]\s*/i, "").trim();
  }
  mwLog("scrape_attempt_start", "debug", {
    mainH1Count: allH1s.length,
    h1El: describeEl(h1),
    title: title.slice(0, 80),
  });

  const priceMatch = fullText.match(/\$[\d,]+(?:\.\d{2})?/);
  const price = priceMatch ? priceMatch[0] : "";

  const { description, descriptionSource } = extractDescription(main, h1);

  mwLog("scrape_attempt_end", "debug", {
    descSource: descriptionSource,
    descLen: description.length,
    descSnippet: description.slice(0, 300),
    title: title.slice(0, 80),
    price,
  });

  // Location: "City, ST" or "City, Country"
  const locMatch = fullText.match(
    /\b([A-Z][a-zA-Z.'-]+(?: [A-Z][a-zA-Z.'-]+)*),\s*([A-Z]{2}|[A-Z][a-zA-Z]+)\b/
  );
  const location = locMatch ? locMatch[0] : "";

  return { title, price, location, description };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
