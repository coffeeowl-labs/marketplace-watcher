# marketplace-watcher

A Firefox extension plus Python helper that scores Facebook Marketplace
listings as **steal**, **good**, **fair**, or **skip** using Claude — and
discounts each verdict by the round-trip cost of driving to pick the item
up from your home address.

The extension talks to the helper via Firefox [native messaging][nm], so
there's no localhost server to start, no auth token to paste, and nothing
to autostart at login.

License: MIT.

[nm]: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging

## Install

You need [Claude CLI][claude] installed and authenticated, plus
[`uv`][uv] (or any Python 3.11+ environment that can run console-script
entrypoints).

### Linux / macOS

```sh
# 1. Install the helper (one-time):
uv tool install git+https://github.com/coffeeowl-labs/marketplace-watcher
marketplace-watcher install
```

### Windows

```powershell
# 1. Install uv if you don't have it:
winget install --id=astral-sh.uv

# 2. Install the helper:
uv tool install git+https://github.com/coffeeowl-labs/marketplace-watcher

# 3. IMPORTANT: refresh PATH so the new shim is findable, then open a
#    new PowerShell window before continuing. `marketplace-watcher` and
#    `claude` both need to be on PATH for the next step.
uv tool update-shell

# 4. In the NEW terminal window:
marketplace-watcher install
```

If step 4 errors with "Claude CLI not found on PATH" or "host shim not
found", you skipped step 3 or are still in the original terminal window
— open a fresh PowerShell and rerun step 4.

### What `install` does

It writes the native-messaging-host manifest to every applicable location
for your platform, verifies the Claude CLI is on `PATH`, and records its
absolute path so the host process can find it later (even when launched by
a GUI-shortcut browser that doesn't inherit your shell's `PATH`).

Per-platform coverage:

- **Linux** — detects stock Firefox, Zen, LibreWolf, Waterfox, Floorp
  (shared `~/.mozilla/native-messaging-hosts/`), plus Snap Firefox, Flatpak
  Firefox, and Flatpak Zen at their sandboxed paths. Installs to every one
  detected; falls back to the stock Firefox path if none are detected.
- **macOS** — all Gecko browsers (Firefox, Zen, and the LibreWolf/Waterfox/
  Floorp forks) share `~/Library/Application Support/Mozilla/
  NativeMessagingHosts/`. Because macOS `.app` bundles from a DMG usually
  aren't on `PATH`, detection often finds nothing — so `install` writes to
  that shared dir unconditionally, which all of them read.
- **Windows** — writes one `HKCU\Software\Mozilla\NativeMessagingHosts\`
  registry key (pointing at a JSON manifest in your config dir). This is
  browser-agnostic for anything that reads the standard Mozilla key.
  **Caveat:** Firefox is verified; whether Zen / LibreWolf on Windows read
  the Mozilla key or their own registry hive is **untested** — if a Windows
  fork reports "no such native application," that's the likely cause.

### Install the signed extension

Open this URL in Firefox / Zen:
<https://github.com/coffeeowl-labs/marketplace-watcher/releases/download/v0.2.0/marketplace-watcher-0.2.0.xpi>

Firefox will prompt for permission to install. The extension is signed by
Mozilla via AMO (unlisted), so it persists across browser restarts.

[claude]: https://code.claude.com/docs/en/setup
[uv]: https://docs.astral.sh/uv/

## Configure

Open the extension's options page (Firefox menu → Add-ons and themes →
Marketplace Watcher → Preferences).

| Field | Default | Notes |
|-------|---------|-------|
| Home address | *(empty)* | Required for trip-cost analysis. Geocoded once via Nominatim on save. |
| Hourly time cost ($/hr) | 20 | Used to value round-trip driving time. |
| Gas price ($/gal) | 5 | Round-trip fuel cost = `(2 × distance / mpg) × gas_price`. |
| Vehicle efficiency (MPG) | 25 |  |

The options page also has an **Evaluation profiles** section: add, rename,
edit, and delete named criteria blocks. Each profile is a name plus a
free-text prompt describing your fit requirements. Profiles you define here
populate the per-card picker on the search page. Edits sync to open
Marketplace tabs without a reload.

The three pills at the top of the page show live status:

- `helper: connected` — native-messaging port to the helper is open.
- `claude: ok` — the helper found and can launch the Claude CLI.
- `last: <time> · <status>` — outcome of the most recent batch.

Without a home address, listings are still evaluated using title, price,
location, description, and (on the explicit re-analyze flow) photos —
just without the trip-cost adjustment.

## Use

Open `facebook.com/marketplace` and run a search. Each listing card gets a
small **dropdown picker** in its top-left corner. There's no "Evaluate"
button — selecting a listing *is* the trigger.

Picker options:

- **None** — not selected (default).
- **Evaluate (default)** — evaluate with no extra criteria.
- *(your profiles)* — evaluate against a saved criteria profile (see below).
- **Junk (hide)** — permanently hide this listing. Useful for the junk
  Marketplace recycles into your results once it runs out of real matches.

When you pick anything other than None/Junk, the listing enters a short
**~2-second grace window** (badge shows `QUEUING…`) during which you can
change your mind — pick None to cancel before any work happens. After that
it scrapes the listing page, then waits in a queue.

### Batching: 3-listing minimum

Listings ship to Claude in **batches of 3–5**. This is deliberate: the tool
earns its keep when you're *comparing* several candidates, not judging one
in isolation — for a single listing you'd just eyeball it yourself. So a
selected listing shows `WAITING (N more)` until at least **3** are queued.
If you only ever select 1–2, they sit waiting and never evaluate. Once 3+
are queued and you pause for ~2 seconds, the batch ships; verdicts stream
back per-card as Claude finishes each one.

A floating **Stop All** pill appears while anything is in flight — click it
to cancel queued and in-progress evaluations for the current tab.

Cards get colored badges:

- 🟡 **steal** — 30%+ below market, or otherwise exceptional
- 🟢 **good** — 10–30% below market and the trip cost still pencils
- ⬛ **fair** — priced about right, or a decent deal eroded by distance
- 🔴 **skip** — overpriced, suspicious, or made unattractive by trip cost

### Evaluation profiles

Profiles let you attach reusable, first-party criteria to an evaluation —
e.g. a "Small mountain bikes" profile whose prompt is "must be a small
adult frame, full suspension preferred." A listing that clearly violates a
stated criterion can't be rated steal/good. Create and edit profiles in the
options page (see **Configure**); they then appear in every card's picker.

### Re-analyze with photos / notes

Right-click a card's verdict badge to open a context box. You can add notes
(prepended to the description on re-analysis — handy for cues from photos
like "rust on frame") and optionally **Save & Re-analyze** with photos
included in the prompt. Re-analyze runs that single listing immediately,
bypassing the 3-listing minimum.

## Troubleshoot

```sh
marketplace-watcher doctor
```

Reports manifest install state per Gecko-browser path, Claude CLI presence
+ recorded vs. resolved path, manifest schema version, and the tail of the
event log (defaults to `~/.local/state/marketplace-watcher/log/events.log`
on Linux; equivalent platformdirs locations on macOS and Windows).

If the extension's options page shows `helper: disconnected` after a
Python upgrade or after you moved your home directory:

```sh
marketplace-watcher repair
```

Re-resolves and re-writes the absolute paths in the native-host manifest
and helper config. Also exposed as a **Reinstall native host** button in
the extension's options page (Advanced disclosure).

## How it fits together

- **`extension/`** — Firefox MV3 extension. Three background scripts
  (`protocol.js`, `native_messaging.js`, `background.js`) plus content
  scripts: `content/batcher.js` + `content/search.js` on
  `facebook.com/marketplace/*search*` (the picker, the auto-commit batcher
  state machine, and verdict badges) and `content/listing.js` on
  `facebook.com/marketplace/item/*` (the per-listing scraper). Background is
  stateless transport — it owns the host port and the scrape queue but the
  batcher state lives per-tab in the content script. State that must persist
  (cached verdicts, geocoded user location, OSRM route cache, profiles,
  junked-listing ids) lives in `chrome.storage.local`.
- **`marketplace_watcher/`** — Python package installed as a uv tool.
  Two entry points:
  - `marketplace-watcher` — CLI: `install`, `uninstall`, `repair`,
    `doctor`, `serve-native`.
  - `marketplace-watcher-host` — the native-messaging stdio loop that
    Firefox launches when the extension calls `connectNative`.
- **`DISTRIBUTION.md`** — the architecture spec including the locked
  native-messaging protocol (message types, port lifecycles, schema
  versioning, log-piggyback drain, env scrubbing). Read this before
  modifying either side of the bridge.
- **Upstream services** (called directly from the extension, never the
  host): [Nominatim](https://nominatim.openstreetmap.org/) for geocoding
  the home address and each listing's reported location;
  [OSRM](https://router.project-osrm.org/) for driving distance and
  duration. Both are rate-limited to ≤1 req/s with a contact-identifying
  `User-Agent`.

## Privacy

The helper inherits a scrubbed environment (`PATH`, `HOME`, `USER`,
`XDG_*`, `ANTHROPIC_*`, `CLAUDE_*`, plus platform equivalents) when
spawning the Claude CLI subprocess — your other shell variables are not
exposed. Listing data goes to your local Claude CLI only (which then talks
to Anthropic). Nominatim and OSRM see geocode + route queries but no
listing data. No telemetry, no analytics, no third-party servers besides
the upstreams listed above.

The extension declares `data_collection_permissions: ["none"]` in its
manifest — Firefox's forthcoming consent UI will reflect this.
