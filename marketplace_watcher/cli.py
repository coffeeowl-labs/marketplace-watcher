"""User-facing CLI: install / uninstall / repair / doctor / serve-native.

Entry point installed by pyproject.toml as `marketplace-watcher`. The
native-messaging host has its own entry point (`marketplace-watcher-host`,
see host.py); `serve-native` here is for manual testing only.
"""

from __future__ import annotations

import argparse
import json
import sys

from . import __version__


def _cmd_install(args: argparse.Namespace) -> int:
    from .install import run_install
    try:
        result = run_install()
    except SystemExit as e:
        print(str(e), file=sys.stderr)
        return 1
    print(f"marketplace-watcher {__version__} installed.")
    print(f"  claude:         {result.claude_path}")
    print(f"  host shim:      {result.host_shim_path}")
    print(f"  native manifests written:")
    for p in result.manifests_written:
        print(f"    - {p}")
    if result.skipped_paths:
        print(f"  skipped (could not write):")
        for p in result.skipped_paths:
            print(f"    - {p}")
    print()
    print("Next: install the signed extension from the AMO link in DISTRIBUTION.md §8.")
    return 0


def _cmd_uninstall(args: argparse.Namespace) -> int:
    from .install import run_uninstall
    result = run_uninstall()
    print("Removed:")
    for p in result["removed"]:
        print(f"  - {p}")
    if result["failed"]:
        print("Failed:")
        for p in result["failed"]:
            print(f"  - {p}")
        return 1
    if not result["removed"]:
        print("  (nothing to remove)")
    return 0


def _cmd_repair(args: argparse.Namespace) -> int:
    # Repair = install without confirmations. Captures the case where a
    # Python upgrade reshims the entrypoint or the home dir moved.
    return _cmd_install(args)


def _cmd_doctor(args: argparse.Namespace) -> int:
    from .install import run_doctor
    report = run_doctor()
    if args.json:
        print(json.dumps(report, indent=2))
        return 0
    print(f"marketplace-watcher {report['host_version']}")
    print(f"  config:         {report['config_path']}")
    print(f"  log:            {report['log_path']}")
    print()
    cw = report['claude_recorded_path']
    cr = report['claude_resolved_path']
    if cw and cr and cw == cr:
        print(f"  claude:         {cw} (ok)")
    elif cw and not cr:
        print(f"  claude:         {cw} (RECORDED, but `claude` is no longer "
              f"on PATH — run `marketplace-watcher repair`)")
    elif cr and not cw:
        print(f"  claude:         not yet installed (run `marketplace-watcher install`)")
    elif cw != cr:
        print(f"  claude:         MISMATCH")
        print(f"                  recorded: {cw}")
        print(f"                  on PATH:  {cr}")
        print(f"                  run `marketplace-watcher repair`")
    else:
        print(f"  claude:         not found on PATH")
    print()
    print("  native-host manifests:")
    if not report['manifests']:
        print(f"    (none written — run `marketplace-watcher install`)")
    for m in report['manifests']:
        if 'registry' in m:
            ok = "ok" if m['manifest_file_exists'] else "MANIFEST FILE MISSING"
            print(f"    - {m['registry']} -> {m['manifest_file']} ({ok})")
        else:
            ok = "ok" if m['exists'] else "MISSING"
            print(f"    - {m['path']} ({ok})")
    print()
    msv = report['manifest_schema_version']
    emsv = report['expected_manifest_schema_version']
    if msv == emsv:
        print(f"  manifest schema: v{msv} (ok)")
    else:
        print(f"  manifest schema: v{msv}, expected v{emsv} — run "
              f"`marketplace-watcher repair`")
    if report['log_tail']:
        print()
        print(f"  last {len(report['log_tail'])} log lines:")
        for line in report['log_tail']:
            print(f"    {line}")
    return 0


def _cmd_serve_native(args: argparse.Namespace) -> int:
    from .host import main as host_main
    return host_main()


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="marketplace-watcher",
        description="Marketplace Watcher helper — installs and manages the "
                    "Firefox native-messaging host that bridges the extension "
                    "to the Claude CLI.",
    )
    p.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("install",
                   help="Detect installed Gecko browsers and write the "
                        "native-host manifest to each. Verifies Claude CLI "
                        "is present.").set_defaults(func=_cmd_install)
    sub.add_parser("uninstall",
                   help="Remove the native-host manifest(s) and config.json. "
                        "Does not uninstall the package itself."
                   ).set_defaults(func=_cmd_uninstall)
    sub.add_parser("repair",
                   help="Re-run install to refresh the manifest's absolute "
                        "paths. Fixes the common 'helper not connected' state "
                        "after a Python upgrade or home-dir move."
                   ).set_defaults(func=_cmd_repair)
    d = sub.add_parser("doctor",
                       help="Diagnose install state, Claude CLI, manifests, "
                            "log paths, and recent log lines.")
    d.add_argument("--json", action="store_true",
                   help="Machine-readable JSON output.")
    d.set_defaults(func=_cmd_doctor)
    sub.add_parser("serve-native",
                   help="Run the native-messaging stdin/stdout loop (for "
                        "manual testing; Firefox normally launches "
                        "marketplace-watcher-host directly)."
                   ).set_defaults(func=_cmd_serve_native)
    return p


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)
