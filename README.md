# marketplace-watcher

Firefox extension + Python native-messaging host that scores Facebook Marketplace
listings (good deal / fair / overpriced) using Claude, accounting for the trip
cost from your home address.

License: MIT.

## Install

> Status: under construction — final install flow lands with §1 + §2 of
> [DISTRIBUTION.md](./DISTRIBUTION.md). The commands below are the target.

```sh
# 1. Install the host (one-time):
uv tool install marketplace-watcher
marketplace-watcher install

# 2. Install the signed extension from Firefox:
# (AMO unlisted URL — added once §8 lands)
```

Requirements: [Claude CLI](https://code.claude.com/docs/en/setup) installed and
authenticated; [`uv`](https://docs.astral.sh/uv/) (or any Python 3.11+
environment that can run console-script entrypoints); Firefox 121+ or any
Gecko-based browser (Zen, LibreWolf, Waterfox, Floorp).

## Configure

Open the extension's options page. Enter your home address (required for trip
cost). Optionally override the three cost defaults:

- Hourly time cost: $20/hr
- Gas price: $5/gal
- Vehicle efficiency: 25 MPG

The status row should read `✅ helper connected · ✅ Claude CLI ok` when
everything is wired up.

## Troubleshoot

```sh
marketplace-watcher doctor
```

Reports manifest install status, Claude CLI presence, config and log paths,
and the tail of the event log.

If the extension can't reach the helper after a Python upgrade or a home-dir
move:

```sh
marketplace-watcher repair
```

(Also exposed as a "Reinstall native host" button in the options page.)
