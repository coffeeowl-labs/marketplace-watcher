"""Wrapper that runs the JS batcher tests under pytest.

The batcher state machine lives in extension/content/batcher.js and is the
most complex single piece of code in the project. Tests live in tests-js/
and use Node's built-in test runner (zero deps). This wrapper just shells
out so `pytest tests/` covers Python + JS in one command.

Skips cleanly if Node isn't installed — JS tests aren't a hard prerequisite
for working on host-side code, but they ARE required to confidently change
the batcher.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
JS_TESTS_DIR = REPO_ROOT / "tests-js"


@pytest.mark.skipif(shutil.which("node") is None,
                    reason="Node not installed; skip JS batcher tests")
def test_batcher_js_suite_passes():
    if not JS_TESTS_DIR.exists():
        pytest.fail(f"Expected JS tests dir at {JS_TESTS_DIR}")
    # node --test with a glob the shell would expand; pass files explicitly.
    test_files = sorted(JS_TESTS_DIR.glob("*.test.js"))
    if not test_files:
        pytest.fail(f"No *.test.js files found in {JS_TESTS_DIR}")
    result = subprocess.run(
        ["node", "--test", *[str(f) for f in test_files]],
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
    )
    if result.returncode != 0:
        # Surface the full output so a failing JS assertion is debuggable
        # from the pytest report without re-running node manually.
        pytest.fail(
            f"node --test failed (exit {result.returncode}).\n\n"
            f"--- stdout ---\n{result.stdout}\n"
            f"--- stderr ---\n{result.stderr}"
        )
