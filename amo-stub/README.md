# amo-stub

This directory is a near-empty Firefox extension whose ONLY purpose is to
validate that the **final** permission set passes AMO automated unlisted
review **before** we sink time into the §1 native-messaging refactor.

Per DISTRIBUTION.md §8a:

> AMO's unlisted-review pipeline is automated and can auto-reject on permission
> combinations it doesn't like — `nativeMessaging` triggers extra scrutiny,
> and combining it with `tabs` is a known flag. Manual appeal takes days. We
> do not want to discover this after the native-messaging refactor.

The permission set declared in `manifest.json` here matches what the shipped
extension at `../extension/` will declare after the refactor — the only
difference is this stub has a no-op `background.js`.

## Build + submit

```sh
# Install web-ext (one-time; requires Node):
npm install --global web-ext

# Lint:
web-ext lint --source-dir=.

# Build:
web-ext build --source-dir=. --artifacts-dir=../web-ext-artifacts

# Submit unlisted (requires AMO API credentials in env):
export WEBEXT_API_KEY="<JWT issuer from addons.mozilla.org/developers/addon/api/key/>"
export WEBEXT_API_SECRET="<JWT secret>"
web-ext sign --source-dir=. --channel=unlisted \
  --api-key="$WEBEXT_API_KEY" --api-secret="$WEBEXT_API_SECRET" \
  --artifacts-dir=../web-ext-artifacts
```

A pass is a fully-signed `.xpi` returned by AMO within a few minutes. A
reject is a useful early warning — restructure permissions before §1 lands.
