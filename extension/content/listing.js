// content/listing.js — runs on /marketplace/item/<id>/ pages.
// Waits for the React-rendered listing data, scrapes it, reports back.
//
// FB uses obfuscated class names so we identify fields by structure and text:
//   - title:    <h1>
//   - price:    first currency-formatted text in main
//   - description: text following a "Description" header in main, bounded by
//                  the next major section header
//   - location: text matching "City, ST" or "City, Country"

(async () => {
  const listingId = extractListingId(location.pathname);
  if (!listingId) return;

  // Try to expand the description if FB collapsed it behind "See more"
  await clickSeeMoreIfPresent();

  const data = await waitForListingData();
  chrome.runtime.sendMessage({ type: "scraped", listingId, data });
})();

function extractListingId(path) {
  const m = path.match(/\/marketplace\/item\/(\d+)/);
  return m ? m[1] : null;
}

async function waitForListingData(maxWaitMs = 15000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < maxWaitMs) {
    const data = tryScrape();
    if (data.title && data.price && data.description) return data;
    last = data;
    await sleep(500);
  }
  return last || tryScrape();
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

function tryScrape() {
  const main = document.querySelector('[role="main"]') || document.body;
  const fullText = main.innerText || "";

  // The first <h1> on the page belongs to FB's chrome (e.g. "Notifications").
  // Scope to the main content region; fall back to <title> with the
  // "Marketplace - " prefix stripped.
  let title = main.querySelector("h1")?.innerText?.trim() || "";
  if (!title || title === "Notifications") {
    const docTitle = (document.title || "").trim();
    title = docTitle.replace(/^Marketplace\s*[-–|]\s*/i, "").trim();
  }

  const priceMatch = fullText.match(/\$[\d,]+(?:\.\d{2})?/);
  const price = priceMatch ? priceMatch[0] : "";

  // Description: between "Description\n" and the next section header.
  // Common boundaries seen on listing pages: "Seller information",
  // "Meet the seller", "Send seller", "Details", "Condition".
  let description = "";
  const descRe =
    /\bDescription\s*\n+([\s\S]*?)(?=\n\s*(?:Seller information|Meet the seller|Send seller|Message|Save|Share|Details|Condition|Listed|About this vehicle|Location)\b|$)/i;
  const m = fullText.match(descRe);
  if (m) description = m[1].trim();

  // Fallback: longest paragraph-like text block in main
  if (!description) {
    const blocks = Array.from(main.querySelectorAll("span, p, div"))
      .filter((el) => el.children.length === 0)
      .map((el) => (el.innerText || "").trim())
      .filter((t) => t.length > 80);
    description = blocks.sort((a, b) => b.length - a.length)[0] || "";
  }

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
