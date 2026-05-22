# Distribution Readiness

**Reading this doc cold (e.g., starting a fresh session against it):** this is a plan, not a record of completed work. Nothing in the repo has been changed yet. The architecture (native messaging), the gap list (Phase 0 + §1–§14 + §8a), the resolutions, and the order of attack have all gone through three critic passes and a skeptic pass — treat the contents as decided unless a specific item says "decide" or "pick one."

**Decisions already made (don't relitigate):**
- Architecture: Firefox Native Messaging (no HTTP server, no auth token, no autostart service).
- Browser support: Firefox + Zen (§4). LibreWolf/Waterfox/Floorp ride along because they honor the same path. Chromium browsers explicitly out of scope.
- License: MIT (§7).
- CSS `:has()` dependency: rewrite to use data-attribute selectors (§13), no `strict_min_version` bump.
- Debug logging: preserved through the refactor via piggybacked log entries on native-messaging traffic (§12). The `debug_logging` toggle keeps its current user-facing meaning.
- Host distribution: Python package via `uv tool install` (the "Sub-decision" section). PyInstaller binaries remain a future option if friends balk at installing `uv`.

**What's still open and needs the user before code lands:** nothing blocking — Phase 0 (creating the GitHub repo + AMO account + picking the package name) needs the user's hands but not their decisions. Start with the **Order of attack** at the bottom.

**Architectural commitment:** the extension and the helper will communicate via [Firefox/Chrome Native Messaging](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging), not the current localhost HTTP server. Everything below is framed against that target.

**Goal:** a friend installs one Python package and one signed extension, opens the options page, fills in their address and three optional cost fields, and they're done. No localhost ports, no auth tokens to paste, no autostart services for them to manage, no per-OS instruction branches in the README.

Status legend: `[ ]` open · `[~]` in progress · `[x]` done

---

## Why native messaging (and what it deletes from the v0.1 design)

The current `helper/server.py` is a localhost HTTP server because "a Firefox extension cannot spawn subprocesses" — so we bridged through HTTP. Native messaging is the supported way to do exactly that bridge. The extension declares a native host; the browser launches the host binary as a subprocess and pipes JSON messages over stdin/stdout. The host runs only when the extension talks to it, scoped to that one extension by ID.

What this lets us delete:
- **No HTTP server.** No bind port, no `127.0.0.1:8787`, no CORS, no `fetch()` calls to localhost in `background.js`.
- **No auth token / pairing flow.** The native-messaging-host manifest's `allowed_extensions` list IS the auth boundary — only our extension can launch the host. DNS rebinding, other-local-user, and cross-origin attacks all stop being threats.
- **No autostart service.** No systemd user unit, no launchd plist, no Windows Task Scheduler. The browser starts the host on demand and reaps it on disconnect.
- **No port collisions** with other tools the friend runs on 8787.
- **No "is the helper running?" troubleshooting.** If the extension can talk to the browser, the host can be launched.

What we keep: the Claude CLI subprocess, the Nominatim/OSRM lookups, the result cache, the cost-model math. The plumbing under those changes; the logic doesn't.

---

## The setup flow we're building toward

1. **Install the helper.** Friend runs `uv tool install marketplace-watcher` (or equivalent — see §2 sub-decision), then `marketplace-watcher install`. The `install` subcommand:
   - Verifies Claude CLI is present and authenticated; bails with a clear pointer if not.
   - Writes the native-messaging-host manifest JSON to the per-OS location (Firefox: `~/.mozilla/native-messaging-hosts/` on Linux, `~/Library/Application Support/Mozilla/NativeMessagingHosts/` on macOS, an `HKCU` registry key on Windows).
   - Prints the AMO install link for the signed extension.
2. **Install the extension.** One click from the link. Firefox prompts; friend approves.
3. **Configure.** Friend opens the options page once, enters their home address, optionally adjusts the three cost fields. Status row shows `✅ helper connected · ✅ Claude CLI ok`. Done.

That's the entire flow. Every gap below is framed around what stops us from delivering it.

---

## Current state (what we're starting from)

- **Two components:** `extension/` (Firefox MV3) and `helper/server.py` (Python stdlib HTTP server on `127.0.0.1:8787`, shells out to `claude -p --model sonnet`).
- **The HTTP architecture is what's getting refactored.** `background.js:11-13` (`HELPER_URL`, `HELPER_HEALTH_URL`, `HELPER_LOG_URL`), the entire `BaseHTTPRequestHandler` in `helper/server.py`, and the `host_permissions` entry for `http://127.0.0.1:8787/*` in `manifest.json` all go away.
- **No README, no LICENSE, no icons, no installer, no packaging.** Options page has one checkbox.

---

## Sub-decision: how we ship the host binary

Native messaging requires an executable the browser can launch. Two ways to deliver it:

| Approach | Friend prereqs | Build cost |
|---|---|---|
| **Python package + `uv tool install`** (host is a Python script invoked via the entrypoint script `uv` creates) | `uv` (one curl line) + Claude CLI | Low — one `pyproject.toml`, one PyPI/GitHub release tag. |
| **PyInstaller single-file binaries per OS** (attached to GitHub releases) | Just Claude CLI | High — cross-OS build matrix in CI, macOS code-signing/notarization to avoid Gatekeeper warnings, ~30 MB per binary. |

**Recommendation: Python package via `uv tool install`.** `uv` is a 30-second install and friends already need to install Claude CLI anyway (node-based) — adding one Python tooling install is in the noise. We save the PyInstaller + signing pipeline, which is a real engineering tax. The binary-build path stays available later if a friend ever pushes back on the `uv` step.

On Windows, the native-host manifest must point at a `.bat` or `.exe` because the registry lookup expects an executable. `uv tool install` creates a `.exe` shim on Windows automatically — works out of the box.

---

## What the user actually configures

Keep this list short. Anything that can be defaulted gets defaulted.

1. **Home address** — geocoded once on save, used for trip-cost math. Only field with no default.
2. **Hourly time cost** ($/hour) — defaults to $20.
3. **Gas price** ($/gal) — defaults to $5.
4. **Vehicle efficiency** — defaults to 25 MPG.

Anything else (debug logging, model selection, etc.) lives behind an "Advanced" disclosure if it lives in the UI at all.

---

## Phase 0 — Prerequisites (one-time setup before P0 work)

These are accounts and external resources we don't have yet. Each is a 10–30 minute task; doing them up front avoids blocking later steps.

### 0a. Create the GitHub repo
**Gap today:** The project lives only in a local git repo at `/home/ryan/marketplace_watcher`. No remote, no published source for friends to install from.

**Fix:**
- Create a public repo at `github.com/<user>/marketplace-watcher` (or whatever name you prefer — the package, host name, and repo can share it).
- `git remote add origin <url>` locally, push `main`.
- Decide whether to make it public or private. Public is required for `uv tool install git+https://github.com/<user>/marketplace-watcher` to work for friends without credentials; private requires them to authenticate to GitHub. Recommend public — the codebase isn't sensitive once the §10 PII sweep is done, and public is the only option that hits the one-command-install goal.

### 0b. Register an AMO developer account
**Gap today:** No way to submit the signed `.xpi` (§8) or run the permission-stub validation (§8a).

**Fix:**
- Go to `addons.mozilla.org/developers/`. The "developer handle" is just the username on this account — used as the addon owner attribution, and what `web-ext sign` authenticates as. Free.
- Generate API credentials (`JWT issuer` + `secret`) from the account's API Keys page. These go to `web-ext sign` via env vars; keep them out of git. Manual signing only — see §8.
- No verification or wait period; the account is usable immediately. The wait time is on the submitted *extensions*, not the account.

### 0c. Pick the namespace
**Gap today:** Several names need to agree across the GitHub repo, the Python package name on PyPI/`uv tool install`, the native-messaging host name in the manifest, the AMO listing slug, and the extension display name.

**Fix:** Pick one kebab-case name and use it everywhere. `marketplace-watcher` is the obvious choice (matches the current directory name and the doc text). Confirm it's free on PyPI (`pypi.org/project/marketplace-watcher/` returns 404) before committing.

---

## P0 — Required for the target architecture

### 1. Refactor the bridge: HTTP → native messaging
**Scope:** this is the largest single piece of work in the doc. Roughly:

- **Manifest changes (`extension/manifest.json`):**
  - Add `"nativeMessaging"` to `permissions`.
  - Drop `"http://127.0.0.1:8787/*"` from `host_permissions`.
  - Keep `browser_specific_settings.gecko.id` — the native-host manifest's `allowed_extensions` will reference it.

- **Extension side (`extension/background.js`):**
  - Replace the three `HELPER_URL`/`HELPER_HEALTH_URL`/`HELPER_LOG_URL` fetches (lines 11-13, and call sites at 77, 225, 270) with a long-lived `browser.runtime.connectNative("marketplace_watcher")` port. Messages are JSON objects with a `type` field (`"evaluate"`, `"health"`, `"log"`).
  - Add request-id correlation so concurrent evaluate calls and health pings don't tangle on one port. (Or open separate ports per request — simpler, costs one host process spawn per request, which is fine.)
  - Remove `HELPER_HEALTH_TIMEOUT_MS` timeout logic and replace with a port-disconnect handler.
  - The keepalive shim at lines 546-550 becomes unnecessary — native messaging holds the connection itself.

- **Host side (replace `helper/server.py` HTTP layer):**
  - Rewrite the entry point as a stdin/stdout loop: read a 4-byte little-endian length prefix, read that many bytes of JSON, dispatch by `type`, write a length-prefixed JSON reply to stdout.
  - Keep the existing `run_claude`, geocoding, routing, and cost-math logic — those are the actual product. The HTTP request handler is the only piece that goes away.
  - **What actually needs to persist (much less than the earlier draft of this doc claimed).** A quick audit of the existing code: the geocode cache is in the *extension* (`chrome.storage.local` keys `geocode:<query>`, `background.js:618-622`), and the Nominatim/OSRM rate-limit timestamps are in the extension too (`background.js:96-99`). Neither dies with the host. The only in-memory state in the host is the 5-minute `_result_cache` (request-hash idempotency for HTTP-retry handling, `helper/server.py:274-279`). Under native messaging that retry pattern goes away (port disconnect = batch failed; the extension's `verdict:<id>` cache at `background.js:292-294` already provides long-lived per-listing dedup). **Drop `_result_cache` entirely.** No SQLite, no JSON cache file, nothing — install-time config (resolved `claude` path, host-manifest-schema version) goes in a flat config file, but there's no runtime cache to persist.
  - **Scrub the env before the Claude subprocess.** Pass an explicit minimal env to `subprocess.Popen` (PATH, HOME, plus whatever Claude CLI needs to read its config) rather than inheriting the whole shell environment. Defense-in-depth against future Claude tool-use exfil paths.
  - Stderr becomes the only log channel (stdout is reserved for protocol). Pipe stderr to a rotating log file (§12).

- **Port lifecycle: one port per evaluation batch.** When the extension starts a batch, it `connectNative`s a fresh port, sends evaluations over it, and disconnects when the batch ends. Long-lived enough to amortize Claude CLI's 3–5 s startup across the chunks within a batch (the cost that actually matters; Python's 100 ms is noise), short-lived enough that lifecycle handling stays simple — no orphan-host cleanup, no "host has been running for a week, has its state drifted" questions. The options-page status row (§5) gets its own separate port for the duration of the page being open.

- **Message size limits — protocol decision, not a perimeter check.** Firefox caps individual native messages at 1 MB in both directions. Request side (extension → host) is fine: a 20-listing batch payload is small. Response side is the concern: 20 verdicts × verbose Claude `reason` strings + cost-math fields can plausibly push past 900 KB. **Decide once, build it in:** either (a) the host streams one verdict per message (cleanest — also lets the extension show progress as verdicts arrive), or (b) the host returns chunked responses with a `{type: "verdict_chunk", seq, last}` framing. Option (a) is simpler and pairs well with the progress overlay the content scripts already render.

### 2. Package the host as an installable CLI
**Gap today:** `helper/server.py` is a loose script. No way to install, no entrypoint a native-host manifest can reference.

**Fix:**
- Add `pyproject.toml`, package as `marketplace_watcher`, console entrypoint `marketplace-watcher = marketplace_watcher.cli:main`.
- Subcommands:
  - `marketplace-watcher install` → checks Claude CLI (§3), detects every supported Gecko browser present on the system, and writes the native-host manifest to *each* matching directory (not just one — a user with both stock Firefox and Zen should get both working from one command):
    - **Stock Firefox / Zen / LibreWolf / Waterfox / Floorp on Linux:** `~/.mozilla/native-messaging-hosts/` (all of these honor the standard Firefox path)
    - **Snap Firefox** (default on Ubuntu 22.04+): `~/snap/firefox/common/.mozilla/native-messaging-hosts/`
    - **Flatpak Firefox:** `~/.var/app/org.mozilla.firefox/.mozilla/native-messaging-hosts/` (supported as of Firefox's 2022–2023 Flatpak update; older installs may need a `flatpak override --filesystem=~/.mozilla` first — document)
    - **Flatpak Zen:** `~/.var/app/app.zen_browser.zen/.zen/native-messaging-hosts/`
    - **macOS:** `~/Library/Application Support/Mozilla/NativeMessagingHosts/` (Zen on macOS also honors this path)
    - **Windows:** `HKCU\Software\Mozilla\NativeMessagingHosts\<name>` registry key pointing at a JSON file on disk
    
    Detection strategy: probe for executables (`firefox`, `zen-browser` / `zen`, etc.) on PATH and check for the presence of each candidate manifest directory. Install to all detected locations. If nothing's detected, fall back to writing the stock Firefox path and printing where it went so the user can re-run with a flag if their browser lives somewhere unusual. Bakes the resolved entrypoint absolute path into each manifest. Writes the install-time config (resolved `claude` path, host-manifest schema version) to `<platformdirs.user_config_dir>/marketplace-watcher/config.json`. Prints AMO link.
  - `marketplace-watcher uninstall` → removes the manifest from wherever `install` put it.
  - `marketplace-watcher repair` → re-runs the path-resolution + manifest-write step without re-prompting. The fix for the common failure mode where a Python upgrade or moved home directory invalidates the absolute path baked into the manifest. Also surfaced as a "reinstall native host" button in the extension's options page when the port fails to connect (§5).
  - `marketplace-watcher doctor` → prints whether the manifest is in place at each candidate path, whether the path it points at exists, whether Claude CLI works, where logs and cache live. The replacement for `curl 127.0.0.1:8787/health` we lose with the refactor — make this thorough.
  - `marketplace-watcher serve-native` → the actual stdin/stdout host loop (what the manifest points at).
- Use `platformdirs` for log/config paths (replaces hardcoded `~/.local/state/...` at `helper/server.py:30`).
- **Versioning the manifest format.** Bake a `manifest_schema_version` field into `config.json` only — NOT into the on-disk Mozilla native-host manifest JSON. Mozilla's `NativeManifest` schema is closed (validates against a union of stdio/pkcs11/storage shapes, all of which reject unknown keys); any stowaway key makes the whole manifest fail validation and the browser reports "No such native application." On `serve-native` startup, the host reads its own expected version from `protocol.py`, compares to `config.json`, and if they disagree exits cleanly with stderr `please run 'marketplace-watcher repair'`. This catches the case where `uv tool upgrade marketplace-watcher` lands a new version with a manifest change and the friend would otherwise see silent disconnects. The extension surfaces the "repair needed" state in the §5 status row.
- **Maintainer migration note.** For users who already have populated `chrome.storage.local` from the current HTTP design — `verdict:<id>`, `scraped:<id>`, `geocode:<query>`, `user_location` survive unchanged. `debug_logging` becomes meaningless per §12 (delete on first read or migrate to whatever §12 lands on). No data migration script needed.
- Publish either to PyPI or as a `git+https://github.com/...` install target.

### 3. Self-check Claude CLI at install and at runtime
**Gap today:** the helper shells out to `claude -p --model sonnet` (in `run_claude`, around `helper/server.py:209-214`) with no version check, no missing-binary handling. A friend without Claude CLI sees a 7-minute hang then failure.

**Fix:**
- `marketplace-watcher install` calls `shutil.which("claude")` to find the binary regardless of how the user installed it. Claude CLI ships through multiple channels (Anthropic's native installer at `https://claude.ai/install.sh` / `.ps1` / `.cmd`, npm via `@anthropic-ai/claude-code`, Homebrew, WinGet, distro packages) — we don't assume any specific method. If `which` returns nothing, the install subcommand bails with a clear message pointing at the official install docs (`https://code.claude.com/docs/en/setup`) and exits non-zero.
- **Caveat: presence ≠ authentication.** `claude --version` proves install but not login. Before writing code, verify whether Claude CLI exposes a cheap auth-status check (something like `claude auth status`). If yes, use it. If not, the host's `health` message can only honestly report `{"claude_cli": "ok" | "missing"}` — "unauthenticated" gets discovered the slow way, when an evaluation fails. Don't fake the third state.
- Record the absolute path returned by `shutil.which` to the config file at `<platformdirs.user_config_dir>/marketplace-watcher/config.json`. The host process spawned by Firefox inherits its PATH from Firefox (often a GUI-shortcut launch that doesn't include `~/.local/bin`, Homebrew's `/opt/homebrew/bin`, etc.), so capturing the path at install time — when the user's shell PATH **is** available — and persisting it is the only way to reliably find `claude` at runtime. The host's `subprocess.Popen` call uses that absolute path.
- Host's `health` message surfaces the recorded path + check result. Extension's options page status row reads it (§5).

### 4. Browser support: Firefox + Zen (decided)
**Decision:** Firefox-only, which also covers Zen browser. Chromium-based browsers are out of scope for now; revisit only if a friend refuses to install Firefox or Zen. The §1 refactor and the rest of the doc are scoped to the Firefox surface.

**Why this is one decision, not two:** Zen is a Firefox fork and reads its native-messaging-host manifest from the standard `~/.mozilla/native-messaging-hosts/` path (verified against the [Zen issue tracker](https://github.com/zen-browser/desktop/issues/10622)). Same goes for LibreWolf, Waterfox, Floorp. So a single stock-Firefox install path covers all Gecko-based browsers a friend is likely to run, with two exceptions worth handling in §2:
- Flatpak Firefox uses `~/.var/app/org.mozilla.firefox/.mozilla/native-messaging-hosts/`.
- Flatpak Zen uses `~/.var/app/app.zen_browser.zen/.zen/native-messaging-hosts/`.

`marketplace-watcher install` should detect which browsers are present and write the manifest to every applicable location — not pick one. A friend with both stock Firefox and Zen installed should get both working from one install command.

**What we're explicitly skipping (Chromium):** Chrome/Edge/Brave would require a separate build with `service_worker` instead of `background.scripts`, plus porting `background.js` to survive service-worker restart (top-level mutable state at `background.js:109-116`, the `setInterval` keepalive at 548-550, in-memory rate-limit timestamps around 664). About a week of careful work. Park in P3.

### 5. Build out the extension's options page
**Gap today:** `extension/options.html` has one checkbox (`debug_logging`). No UI for home location, cost params, or anything else. A new user can't configure the extension from the UI at all.

**Fix:**
- Redesign `options.html` / `options.js` around the four-field user surface above.
- Top: live status row reading from the host's `health` message — `helper: connected/disconnected · claude cli: ok/missing · last evaluation: <timestamp / error>`.
- Home address: text field; on save, geocode via Nominatim, store result in `chrome.storage.local.user_location` (already the storage key — `background.js:654`).
- Cost fields: hourly $/hr, $/gal, MPG; defaults match the current hardcoded values (`background.js:100-102`).
- **First-run-no-address banner.** When `user_location` is unset, the options page shows a "Set your home address to enable trip-cost analysis" prompt. Separately, audit `background.js` to confirm the evaluation pipeline degrades gracefully when `user_location` is absent — verdicts should still be produced from listing data alone, with trip-cost fields omitted rather than causing a crash. If the current code doesn't degrade cleanly, fix as part of this section.
- Advanced disclosure: "reinstall native host" button (calls a host message that re-runs the install step), log location link. (`debug_logging` toggle's fate is resolved in §12 — likely deleted.)
- Update the host's SYSTEM_PROMPT (the "$20/hour" literal around `helper/server.py:53`) to receive the values from the request payload rather than hardcoding — otherwise the prompt and the math drift.

### 6. Add extension icons
**Gap today:** No `icons` key in `manifest.json`. AMO will reject the upload (§8).

**Fix:** PNGs at 16, 32, 48, 96, 128 px under `extension/icons/`, referenced from the manifest. A simple lettermark is fine.

### 7. License: MIT (decided)
**Gap today:** No `LICENSE`. Friends technically can't redistribute or fork.

**Fix:** Drop a standard MIT `LICENSE` file at the repo root (copyright Ryan Jacobs, current year). Add a one-line "License: MIT" mention to the README.

### 8. Ship a signed `.xpi` via AMO unlisted submission
**Gap today:** "Load Temporary Add-on" doesn't persist across restarts. Also: the native-messaging-host manifest's `allowed_extensions` list needs the *signed* extension ID, which AMO assigns. Unlisted is fastest.

**Fix:**
- Register an AMO developer account.
- Build with `web-ext build`.
- Submit as **unlisted** → signed `.xpi` URL via AMO. Automated review is usually minutes for benign extensions, but `nativeMessaging` + `tabs` can route to human review (hours to days). §8a is the early-warning system for this. Either way, the resulting XPI doesn't appear in public AMO search.
- Bake the resulting signed extension ID into the native-host manifest the installer writes. (Or: install-time, prompt the user for it once, but the bake-in is friendlier and the ID is stable across signed releases.)
- Keep signing manual / off-CI. AMO credentials in CI = leak risk; we don't ship often enough to need automation.

### 8a. Validate AMO will accept the extension *before* sinking time into §1
**Gap today:** AMO's unlisted-review pipeline is automated and can auto-reject on permission combinations it doesn't like — `nativeMessaging` triggers extra scrutiny, and combining it with `tabs` is a known flag. Manual appeal takes days. We do not want to discover this after the native-messaging refactor.

**Fix:** Before starting §1, submit a near-empty stub extension that declares the *final* intended permissions (`nativeMessaging`, `tabs`, `storage`, current `host_permissions`) but does nothing useful. Confirm it passes automated unlisted review. If it gets flagged, we either appeal or restructure the permission set now — cheaper to learn at this stage than after the refactor lands. Half a day's work, days of insurance.

---

## P1 — Required for the experience to feel finished

### 9. README that mirrors the one-command flow
**Gap today:** No README.

**Fix:** Three sections only — *Install* (the `uv` one-liner + `marketplace-watcher install` + the AMO link), *Configure* (screenshot of options page with the four fields), *Troubleshoot* (run `marketplace-watcher doctor`). No per-OS branches in the main flow; the installer handles them.

### 10. PII sweep before any public push
**Gap today:** Your email, home address, or test data may exist in git history, default values, or this doc (an earlier revision leaked your email — sweep this file too).

**Fix:**
- `git log -p | grep -iE '<your-handle>|<your-address>|<your-zip>'` against the whole repo including `DISTRIBUTION.md` and the future README.
- Expand `.gitignore`: `.env`, `*.local.json`, `events.jsonl`, editor swap files.

### 11. Friendly User-Agent on Nominatim / OSRM
**Gap today:** `background.js:97-99` rate-limits to ~1 req/s (good) but no meaningful User-Agent on the geocoding/routing fetches. Multiple friends under a default UA risks a blanket block from OSRM's demo server.

**Fix:** Set `User-Agent: marketplace-watcher/<version> (https://github.com/<user>/<repo>)` and a `Referer` on those fetches. README links the upstream usage policies. Self-host if this ever scales beyond a handful of friends.

---

## P2 — Quality of life

### 12. Preserve unified event logging through the native-messaging refactor
**Gap today:** `helper/server.py:31` appends to `events.jsonl` forever with no rotation. The extension writes to this log by POSTing to the helper's `/log` HTTP endpoint, gated by the `debug_logging` toggle (`background.js:19-33`). §1 deletes that endpoint along with the rest of the HTTP layer — so without a plan, the unified extension+host event log disappears.

**Fix (the goal is a single chronological log file containing both extension events and host events, same as today, kept rotating):**

- **Host-side logging:** the host's stderr is routed to `<platformdirs.user_log_dir>/marketplace-watcher/events.log` via `logging.handlers.RotatingFileHandler` (10 MB, keep two generations). All `run_claude` invocations, geocode/route calls, and per-batch summaries land here. Replaces the current `events.jsonl` write path.

- **Extension-side logging — piggyback on existing native-messaging traffic.** The extension never opens a port *just* to log. Instead:
  - Every native message the extension already sends (a batch request, a status-port message) carries an optional `logs: [{ts, level, event, ...}]` array of pending entries.
  - The host writes those entries to the same rotating log file before processing the rest of the message. One log file, chronological order preserved.
  - The extension maintains a ring buffer of pending log entries in `chrome.storage.session` (volatile, no quota concern, survives extension reload within a Firefox session).
  - For events that happen between batches (passive scraping, user opening the options page), the buffer flushes on the next outgoing message. The options-page status port (already long-lived per §1) flushes continuously when the page is open — covers the common "I want to watch what's happening right now" case.
  - **Backstop for prolonged between-batch activity:** if the buffer exceeds 200 entries or 5 minutes without a flush, the extension opens a one-shot `log_flush` port to drain it. Caps memory and bounds log-latency without making the host long-lived.

- **`debug_logging` toggle keeps its current meaning:** when off, the extension drops log entries on the floor (no buffer, no flush). When on, the buffer/flush pipeline runs. Default stays **on**. The host's own logging is unaffected by the toggle — host-side errors and Claude transcripts always get written, since those are what we actually need when a friend reports a bad verdict.

- **`marketplace-watcher doctor`** prints the log file path and tail of the last N lines, replacing the "look in `~/.local/state/marketplace_watcher/`" muscle memory.

### 13. Rewrite `overlay.css` to drop the `:has()` dependency (decided)
**Gap today:** `extension/content/overlay.css` uses `:has()`, which works in Firefox 121+. Manifest sets `strict_min_version: "115.0"`. Users on 115–120 see broken styling silently. Firefox ESR 115 is supported through late 2025 and is common in managed/corporate environments.

**Fix:** Replace `:has()` with explicit data-attribute selectors set by the content script:
- The `:has()` selectors at `extension/content/overlay.css:351-357` style the card (`[data-mw-card]`) based on what badge it contains. `extension/content/search.js` already attaches and removes badges (`attachBadge` at line 281, badge removal in `attachOverlays` lines 159 and 182).
- Add a single `card.dataset.mwState = <state>` write next to every `badge.className = ...` assignment in `attachBadge`. Set `data-mw-state="unanalyzed"` when `attachCheckbox` runs. Clear the attribute wherever the badge is removed.
- Replace the `:has()` selectors in CSS with attribute selectors against `[data-mw-state="..."]`.

**Fragility note:** this is *less* fragile than `:has()`, not more — the attribute selector is an explicit contract between the content script and the stylesheet rather than a runtime DOM-tree query. The only discipline required is keeping the attribute write co-located with the badge write (same function, same call site) so they can't drift. The content script already manages badge lifecycle; this is one extra line per call site.

**No fallback needed.** If the rewrite is uglier than expected, the answer is to refactor the badge-attach code, not to fall back to bumping `strict_min_version`.

### 14. Surface the last evaluation result
**Gap today:** When evaluations fail (Claude timeout, host crash, Nominatim 429), failures are retried/swallowed. Friends won't know what's wrong vs. just slow.

**Fix:** "last evaluation: <timestamp> · <ok / error: ...>" line in the options page status row. Half-built once §5 lands.

---

## P3 — Deferred

- **Auto-updates.** AMO handles the extension automatically. For the host: `uv tool upgrade marketplace-watcher`. Worth a one-line `marketplace-watcher self-update` wrapper if updates ship often enough.
- **Cross-browser (§4 Option B)** if friends ask for Chrome.
- **Non-US units / multi-currency** in the cost model.
- **Telemetry / opt-in crash reporting.** Probably never for a friends-only tool.

---

## Risks and downsides

Honest accounting of what each proposal costs us or could go wrong with. Worth re-reading before committing to execute.

### Native-messaging refactor (§1) — the things HTTP gave us for free

- ~~**No host process across browser restarts means in-memory state evaporates.**~~ *Resolved in §1, but smaller than this risk first claimed: the only in-memory state in the host is the 5-min `_result_cache`, and that's only relevant for the HTTP-retry pattern that goes away with the refactor. The geocode and rate-limit state were already in `chrome.storage.local` and survive natively. **No disk-backed cache needed.***
- **Per-evaluate-request process spawn cost.** Python interpreter cold start (~100–300 ms) on top of Claude CLI's ~3–5 s. *Resolved in §1: port-per-batch — the Python startup is paid once per batch and Claude CLI startup amortizes across the batch's chunks within one host process.*
- **Debugging is meaningfully harder.** Today: `curl 127.0.0.1:8787/health`, tail the server log, hit endpoints from a terminal. After: the host only speaks length-prefixed JSON on stdin; no out-of-band probe. `marketplace-watcher doctor` helps but doesn't fully replace a curl-able endpoint. Development velocity takes a hit.
- **Snap and Flatpak Firefox use different manifest paths.** Snap: `~/snap/firefox/common/.mozilla/native-messaging-hosts/`. Flatpak: `~/.var/app/org.mozilla.firefox/.mozilla/native-messaging-hosts/` (works as of Firefox's 2022–2023 Flatpak update; older installs may need a `flatpak override` first). *Resolved in §2: `install` detects flavor and writes to the matching directory; multi-Firefox case prompts.* Still the single most common native-messaging failure mode in the wild — worth manual testing on at least one Snap install before declaring §2 done.
- **Absolute path in the host manifest is brittle.** `marketplace-watcher install` writes a manifest pointing at the resolved entrypoint path. If `uv` reshims the tool (e.g. on a Python minor-version bump), or the user moves their home directory, the manifest goes stale and the only symptom is "extension says helper not connected." *Resolved in §2: `marketplace-watcher repair` subcommand + "reinstall native host" button in §5's options page.*
- **The host can't push.** Only the extension can `connectNative`. If we ever want the host to notify the extension of something (config-file changed externally, log file rotated, Claude logged out), the extension has to poll. Not a problem today, but it eliminates designs we might want later.
- **AMO automated review may scrutinize `nativeMessaging`.** Native messaging is allowed on AMO but the review pipeline flags it. Unlisted is automated review only; if the heuristics get strict, we get auto-rejected with limited recourse beyond a manual appeal that takes days. *Resolved in §8a: validate the permission set with a stub upload before sinking time into §1.*
- **One extension, one host.** The HTTP design could in principle serve other tools (a CLI for the same machine, a future companion). Native messaging locks the host to one extension ID. Marginal loss.
- **No remote debugging or shared-machine use.** HTTP on `127.0.0.1` is at least theoretically reachable via SSH tunnel from another machine for testing. Native messaging is strictly local. Probably not relevant, but a future option we're closing.

### Distribution via `uv tool install` (the sub-decision)

- **`uv` is moving fast and ships breaking changes.** Pinning at install time is fine; pinning across friends who install months apart is messier.
- **Adds yet another Python tool manager** to friends who may already have pyenv/conda/system pip and don't want a sixth. The `uv` evangelism cost is non-zero.
- **`curl … | sh` install line scares some people**, justifiably. There's a `pipx install uv` alternative but now we're recommending two tools.
- **`uv tool` shim path varies by OS and Python version.** The shim that the native-host manifest points to is generated at install time; a Python upgrade can break it. The "absolute path is brittle" point above stacks with this one.

### Self-check Claude CLI (§3)

- **`claude --version` proves install, not authentication.** *Resolved in §3: don't fake the third state — `health` reports `ok | missing` only unless we confirm Claude CLI exposes a real auth-status check.*
- **Subprocess PATH may not include the user's Claude install.** A Python process spawned by Firefox inherits PATH from Firefox, not from the user's shell. If `claude` is in `~/.local/bin` and Firefox was launched from a GUI shortcut that didn't source shell rc files, `claude` is invisible. *Resolved in §3: `install` captures the absolute path (where shell PATH **is** available) and writes it to a config file the host reads at startup; the runtime subprocess call uses that absolute path.* Same staleness class as the host-manifest path; same `repair` answer.
- **30-second `/health` cache hides recent state changes.** User logs out of Claude, tries an evaluation, sees a confusing pass-then-fail.

### Options page rebuild (§5)

- **`chrome.storage.local` is not encrypted at rest.** Home address sits plaintext in the Firefox profile directory. Anyone with filesystem read on that profile reads the address. Acceptable for a personal-friends tool; worth knowing.
- **Live status polling is a process-spawn pump.** If the options page polls `/health` every second while open, that's a host process per second. *Resolved in §1: the options page holds its own long-lived port for the duration the page is open, separate from batch ports.*
- **Iterative address corrections hit Nominatim's rate limit.** Save → geocode → "that's not right" → edit → save → geocode → repeat will throttle after a few tries. Debounce + cache geocode results by input string.

### AMO unlisted signing (§8)

- **Automated review can auto-reject on permissions it doesn't like.** `tabs` is sometimes flagged; `nativeMessaging` triggers extra scrutiny. Auto-rejection requires a manual appeal that takes days, defeating the "minutes to sign" benefit. *Resolved in §8a: validate with a permission stub before sinking time into §1.*
- **The signed XPI URL is technically public.** If a friend forwards the link, anyone can install. For a personal tool this is unimportant; worth knowing it's not access-controlled.
- **AMO credentials needed for `web-ext sign`.** If we automate the build in CI, those credentials become a leak risk. *Resolved in §8: keep signing manual / off-CI.*
- **Web-ext requires Node.** The build environment now needs both Python (for the host) and Node (for `web-ext`). Two toolchains, two upgrade paths.

### Firefox-only (§4 Option A)

- **Friends who don't use Firefox face a forced browser switch.** For a personal tool to share with a handful of people, this is a real ask.
- **Less community workaround knowledge for Firefox-specific breakage.** If Facebook starts detecting and blocking the extension in a Firefox-specific way (different DOM signature, different content-script timing), there's a smaller community to lean on for fixes than Chrome.

### CSS `:has()` bump (§13)

- **Bumping `strict_min_version` to 121 excludes Firefox ESR 115 users.** ESR is supported through late 2025 and is common in corporate/managed environments. *Resolved in §13: prefer the CSS rewrite (class-based hooks) over the min-version bump; bump only as a fallback if rewrite is too ugly.*

### Underlying trust and contract assumptions (apply across the design)

- **Prompt injection isn't fully solved by the SYSTEM_PROMPT.** Listings are attacker-controlled. A sufficiently clever injection — especially in the `user_notes` carve-out, which is explicitly authoritative — can still warp verdicts. The downstream impact is bounded (the verdict format is structured JSON we re-parse) but we trust Claude to honor the data/instruction boundary perfectly, and it won't.
- **The host inherits the user's full environment.** Subprocesses to `claude` see every env var the user has set, including unrelated API keys. If Claude CLI ever grows tool use that can exfiltrate env (it doesn't today under `-p`), we have a leak path. *Resolved in §1: scrub env to a minimum set before the subprocess call.*
- **Claude CLI's `-p` flag is an unstable contract.** No semver guarantee. Anthropic can rename the flag, change the JSON output shape, or change auth handling tomorrow. We have no version pin we can rely on long-term.
- **Nominatim and OSRM public endpoints have no SLA.** OSRM's demo server explicitly says "not for production." They can blackhole us at any time. Self-hosting (heavy) or accepting periodic outages are the only answers.
- ~~**Default-off `debug_logging` (§12) reduces our ability to debug friend reports.**~~ *Resolved in §12: leave debug on by default; rotation alone bounds disk usage.*

---

## Native-messaging protocol spec (locked — both sides target this)

Locked after the §1+§12 design pass. Both the host (§1 host rewrite) and the extension (§1 background.js rewrite) implement against this contract.

### Wire format

Firefox native-messaging baseline (non-negotiable, browser-imposed):
- 4-byte little-endian length prefix, then that many bytes of UTF-8 JSON.
- 1 MB max per individual message (both directions).
- Process lifetime tied to port lifetime; `port.disconnect()` SIGTERMs the host.
- Stdout is reserved for protocol traffic. **All host logging goes to stderr**, which Firefox swallows but our `RotatingFileHandler` (§12) captures to disk.

### Extension ID (locked)

`marketplace-watcher@coffeeowl-labs.github.io` — replaces the current `marketplace-watcher@local`. Set in `browser_specific_settings.gecko.id`; baked into the native-host manifest's `allowed_extensions` by `marketplace-watcher install`. The §8a stub and the real extension share this ID so the host manifest is wireable before AMO signing.

### Message envelope (every message, both directions)

```json
{
  "type": "...",
  "schema_version": 1,
  "request_id": "uuid-v4",
  ... type-specific fields ...
}
```

**Every host→extension message MUST echo the originating `request_id`.** The extension drops any message whose `request_id` doesn't match the active batch — prevents stale sentinels from a prior batch contaminating a fresh one.

On `schema_version` mismatch the receiver sends `{type:"error", code:"schema_mismatch", host_schema, ext_schema}` and disconnects. The options-page status row branches on directionality:
- `host_schema > ext_schema` → "Update the extension on AMO" (with link)
- `host_schema < ext_schema` → "Run `uv tool upgrade marketplace-watcher`"

A true negotiation handshake is overkill; the directional message gets the user to the right place.

### Port lifecycle

Three port types — each maps to a fresh host process spawn:

1. **Batch port** (one per evaluate batch). Extension opens, sends `evaluate`, receives streamed `verdict` messages plus an `evaluate_done` sentinel. Extension then waits a **250 ms grace** before calling `port.disconnect()` so the host's final write fully drains stdout before SIGTERM arrives. (Firefox SIGTERMs the host on disconnect; without the grace, the last `evaluate_done` can be truncated by the kernel pipe buffer never flushing.) Host process exits with the port.
2. **Status port** (long-lived while options page is open). Carries `health` messages on a slow timer (5 s) and is the primary log-piggyback drain channel.
3. **Log-flush port** (one-shot, backstop). Opened only when the §12 buffer trips its 200-entry / 5-minute backstop and no other port is active.

Per-batch Python-cold-start cost (~100–300 ms) is paid once and amortized across the chunked claude subprocesses within the batch — same trade the doc §1 already commits to.

**Host shutdown discipline.** Host installs a SIGTERM handler that (a) sets a shutdown flag, (b) lets the main loop write `evaluate_done` if not yet sent, (c) calls `sys.stdout.flush()` and `os.fsync(1)` where supported, (d) exits 0. Host opens `sys.stdout = os.fdopen(1, "wb", buffering=0)` at startup so length-prefixed binary framing isn't subject to stdio buffering. Symmetrically: the host's stdin reader uses a `read_exact(n)` helper that loops until `n` bytes or EOF; a clean EOF before a length prefix is normal shutdown, an EOF mid-prefix or mid-payload is logged to stderr and the host exits 1.

### Extension → host messages

- **`evaluate`** — `{listings:[...], cost_params:{hourly_rate, gas_per_gallon, mpg}, logs?:[...]}`. The listing shape is unchanged from the current POST /evaluate body. Cost params replace the host's hardcoded `$20/hour` string interpolation; the host inlines them into SYSTEM_PROMPT at send time. `logs` is the optional piggyback.
- **`health`** — `{logs?:[...]}`. Triggers a `health_result` reply.
- **`log_flush`** — `{logs:[...]}`. Backstop drain; replies with `log_ack`.
- **`reinstall_native_host`** — `{}`. Re-runs the install step from inside the host process (same code path as the CLI `repair` subcommand). Replies with `reinstall_done`.

### Host → extension messages

- **`verdict`** — `{verdict:{id,verdict,reason,...}, seq}`. Streamed one per listing as chunks complete. `seq` is a monotonic counter; the `evaluate_done` sentinel defines end-of-batch (no `of` field — chunk failures would make `of` ambiguous). The extension writes each `verdict:<id>` into `chrome.storage.local` on receipt — incremental commit, so a mid-batch disconnect leaves successfully-evaluated listings cached.
- **`evaluate_done`** — `{error:null | {code, message}}`. Sentinel; exactly one per batch. Error codes: `claude_missing`, `claude_failed`, `claude_timeout`, `verdict_id_mismatch`, `internal_error`.
- **`health_result`** — `{claude_cli:{status:"ok|missing|unknown_auth", path, version}, host_version, schema_version_match, log_path, last_evaluation:{ts_iso, ok, error}}`.
- **`reinstall_done`** — `{error:null, manifests_written:[paths], claude_cli_path, restart_required:true}`. Host then exits. Extension does NOT attempt to reuse the port; UI says "Reinstalled — reload the options page." Reason: rewriting the manifest/registry the running host was launched from is racy (Firefox may cache the manifest path; on Windows AV/UAC can deny in-process HKCU writes silently), so the only safe contract is "rewrite, reply, exit, force a fresh `connectNative` to validate."
- **`log_ack`** — `{wrote:N}`.
- **`error`** — `{code, message, host_schema?, ext_schema?, needs_repair?}`. Fatal protocol/version errors.

### Verdict-size discipline (1 MB cap defense)

Model-generated `reason` strings are unbounded. A single oversized message gets silently dropped by Firefox at the 1 MB cap. The host enforces:
- `MAX_REASON_BYTES = 32 * 1024` — truncate `reason` to 32 KB.
- `MAX_VERDICT_BYTES = 256 * 1024` — if the whole serialized `verdict` message still exceeds 256 KB after `reason` truncation, replace the verdict body with `{id, verdict, reason:"<truncated>", _truncated:true}`.

This is belt-and-suspenders: the 32 KB reason cap should make the 256 KB ceiling unreachable in practice, but other fields could grow unexpectedly.

### Incremental-commit dedup (extension-side)

The batch-resume story relies on this being explicit, not implicit: **`background.js` batch construction MUST `chrome.storage.local.get` the candidate listing IDs' `verdict:<id>` keys and filter out already-evaluated ones before opening the batch port.** A mid-batch crash leaves a partial set cached; the next attempt naturally skips those listings. The host never sees an ID it has already evaluated; the existing `_result_cache` becomes truly unnecessary.

Already implicit in `background.js:292-294` (the pre-batch cache read), but the post-§1 implementation must preserve this pre-filter rather than accidentally moving the check into the host.

### What this deletes from the current design

- **`_result_cache` (helper/server.py:277-279).** The HTTP-retry pattern it served goes away; per-listing `verdict:<id>` in `chrome.storage.local` already gives long-lived dedup, and incremental verdict streaming means partial-failure recovery doesn't need a server-side hash cache.
- **`_inflight` (helper/server.py:279).** Same reason.
- **The 20 s `getPlatformInfo` keepalive (background.js:548-550).** Native-messaging holds the connection itself; the MV3 event-page suspension that motivated this no longer threatens the batch.
- **The 1 s `setInterval(flushLogs)` (background.js:87).** Logs piggyback outgoing messages instead.
- **The full `BaseHTTPRequestHandler` class (helper/server.py:414-522)** plus the `ThreadingHTTPServer` bootstrap.

### What this preserves

- `evaluate_parallel` chunked fan-out (`helper/server.py:385-411`). Each chunk still runs in its own thread with its own claude subprocess. **Stdout ownership: only the main thread writes stdout.** Worker threads push verdicts onto a `queue.Queue`; the main thread drains it, writes `verdict` messages, increments a `done_count`, and writes `evaluate_done` exactly once when `done_count == len(listings)` OR the first fatal error arrives. This avoids the "who owns the sentinel" problem inherent to `as_completed` and removes the need for a `_stdout_lock`. Per-listing streaming-from-claude is a future enhancement (P3).
- Unified extension+host event log. The piggyback drain writes both sides' entries to the same `RotatingFileHandler`, preserving chronological order in one file.
- `verdict:<id>`, `geo:<query>`, `route:<a>>><b>`, `scraped:<id>`, `context:<id>`, `user_location`, `filter_visibility` storage keys (extension side). All survive the refactor unchanged.

### Log-piggyback concurrency (status port + batch port simultaneously)

When the options page is open while a batch is running, two ports are active and either can drain the log buffer. Without discipline this either double-sends entries or loses them on host crash.

- Each log entry gets a monotonic `seq` at enqueue time, plus an extension `session_id`.
- The extension serializes drains with `navigator.locks.request("mw-log-drain", ...)` — exactly one port owner at a time. The owner removes-and-sends atomically.
- The host deduplicates by `(session_id, seq)` as belt-and-suspenders in case a flush is retried after a flaky disconnect.

### Subprocess env (host side, platform-conditional)

The claude subprocess gets an explicit per-platform allowlist, not `os.environ`. The Linux-only allowlist in the original draft breaks Windows (no `USERPROFILE`/`PATHEXT`/`SYSTEMROOT` means `claude.cmd` can't be located or launched), and misses corp-MITM proxy and npm-installed-Claude variables.

```python
COMMON = {
    "PATH", "LANG", "TMPDIR",
    "SSL_CERT_FILE", "SSL_CERT_DIR",          # corp MITM proxies
    "NODE_PATH", "NPM_CONFIG_PREFIX",         # npm-installed claude
}
COMMON_PREFIXES = ("ANTHROPIC_", "CLAUDE_", "LC_")

POSIX = COMMON | {"HOME", "USER", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"}
WINDOWS = COMMON | {"USERPROFILE", "APPDATA", "LOCALAPPDATA", "SYSTEMROOT",
                    "SYSTEMDRIVE", "COMSPEC", "PATHEXT", "TEMP", "TMP"}
MACOS = POSIX | {"DYLD_FALLBACK_LIBRARY_PATH"}  # only if measurably needed
```

Plus the resolved absolute path to `claude` from `config.json` (§3) is used directly — we don't rely on the subprocess's `PATH` to find it.

### Stderr routing (host side)

Stderr is **not** something we can assume Firefox routes anywhere useful — it inherits to the launching terminal on Linux CLI launches, but goes to journald or `/dev/null` on GUI launches depending on distro. The host opens its own `RotatingFileHandler` against `<platformdirs.user_log_dir>/marketplace-watcher/events.log` at startup and writes there directly. Stderr stays as a secondary channel (useful when running `marketplace-watcher serve-native` manually from a terminal for debugging) but isn't load-bearing.

### Subprocess env (host side)

The claude subprocess gets an explicit allowlist, not `os.environ`:

```python
SUBPROCESS_ENV_ALLOWLIST = {"PATH", "HOME", "USER", "XDG_CONFIG_HOME", "TMPDIR", "LANG"}
SUBPROCESS_ENV_PREFIXES = ("ANTHROPIC_", "CLAUDE_", "LC_")
```

Plus the resolved absolute path to `claude` from `config.json` (§3) is used directly — we don't rely on the subprocess's PATH to find it.

### Two CLI entrypoints (locked, replaces "one entrypoint" implication in §2)

`pyproject.toml`:
```toml
[project.scripts]
marketplace-watcher = "marketplace_watcher.cli:main"          # user-facing CLI
marketplace-watcher-host = "marketplace_watcher.host:main"    # native-host entrypoint
```

The native-host manifest's `path` points at the `marketplace-watcher-host` shim (a console-script wrapper `uv tool install` generates). This avoids needing to invoke `marketplace-watcher serve-native` via a shell wrapper.

### Schema versioning

`SCHEMA_VERSION = 1` constant in both `marketplace_watcher.protocol` (host) and `extension/protocol.js` (extension). Bumped together with any breaking change. On mismatch, the extension surfaces "needs repair" in the status row — same UX as the manifest-schema mismatch in §2.

---

## Order of attack

1. **Phase 0** — Create the GitHub repo (§0a), register the AMO account (§0b), confirm the `marketplace-watcher` name is free (§0c). Half an hour total.
2. **§7 LICENSE** + skeleton README. Trivial; unblocks publishing anything publicly.
3. **§8a AMO permission-stub validation.** Half a day; learn before §1 whether the final permission set will pass automated unlisted review. Submit a near-empty extension declaring `nativeMessaging` + `tabs` + `storage` and see if it gets auto-signed.
4. **§1 native-messaging refactor.** The architectural foundation; everything else depends on the new host shape. Includes the port-per-batch commitment, env-scrubbing, and the log-piggyback protocol from §12.
5. **§2 host CLI packaging** + **§3 Claude-CLI detection.** The installer, including all Firefox/Zen path variants and the `repair` subcommand.
6. **§5 options page rebuild** + **§6 icons** + **§13 CSS rewrite**. The user-facing surface. CSS rewrite can land in parallel with the options page work.
7. **§8 AMO unlisted signing.** Once the extension is otherwise done; gives us the stable signed ID that gets baked into the native-host manifest.
8. **§10 PII sweep**, then **§9 README** finalization. In that order — README is partly a status check on the rest.
9. **§11 (User-Agent), §12 (log rotation), §14 (last-evaluation surface)** as polish.

§1 is the largest single piece; everything from §2 onward is hours, not days.
