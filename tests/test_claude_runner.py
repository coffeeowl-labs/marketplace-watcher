"""evaluate_parallel_streaming behavior — focus on the producer/consumer
contract that came out of the protocol-spec critic pass: workers push to
a queue, the caller's thread is the only stdout writer, on_done fires
exactly once even when individual chunks fail."""

from __future__ import annotations

from unittest.mock import patch

import pytest

from marketplace_watcher.claude_runner import (
    CHUNK_SIZE,
    CostParams,
    _ChunkResult,
    build_system_prompt,
    build_user_prompt,
    evaluate_parallel_streaming,
)


def _listings(n: int) -> list[dict]:
    return [{"id": str(i), "title": f"t{i}", "price": "$1", "location": "loc"} for i in range(n)]


def test_build_system_prompt_interpolates_hourly_rate():
    p = build_system_prompt(CostParams(hourly_rate=42.5))
    assert "$42.5/hour" in p
    # Sanity: didn't accidentally template a different literal
    assert "$20/hour" not in p


def test_build_system_prompt_default_rate():
    p = build_system_prompt(CostParams())
    assert "$20/hour" in p


def test_build_user_prompt_includes_listing_xml():
    out = build_user_prompt([{"id": "abc", "title": "T", "price": "$5", "location": "L"}])
    assert '<listing id="abc">' in out
    assert "<title>T</title>" in out
    assert "<price>$5</price>" in out


def test_build_user_prompt_user_notes_emitted_when_present():
    listings = [{"id": "1", "title": "t", "price": "$1", "location": "l",
                 "user_context": "rust on frame"}]
    out = build_user_prompt(listings)
    assert "<user_notes>rust on frame</user_notes>" in out


def test_build_user_prompt_criteria_emitted_when_profile_prompt_present():
    listings = [{"id": "1", "title": "t", "price": "$1", "location": "l",
                 "profile_prompt": "must be full suspension"}]
    out = build_user_prompt(listings)
    assert "<criteria>must be full suspension</criteria>" in out


def test_build_user_prompt_no_criteria_when_profile_prompt_absent():
    listings = [{"id": "1", "title": "t", "price": "$1", "location": "l"}]
    out = build_user_prompt(listings)
    assert "<criteria>" not in out


def test_build_user_prompt_no_criteria_when_profile_prompt_empty_string():
    # A trimmed-empty profile_prompt (e.g. only whitespace) must not emit
    # a <criteria> element — that would tell Claude there are criteria to
    # check when the user provided none, which would confuse the verdict.
    listings = [{"id": "1", "title": "t", "price": "$1", "location": "l",
                 "profile_prompt": "   \n  "}]
    out = build_user_prompt(listings)
    assert "<criteria>" not in out


def test_build_user_prompt_criteria_placement_between_notes_and_photos():
    # The system prompt expects user_notes → criteria → photos ordering so
    # the model sees first-party context (notes + criteria) before the
    # bulk image-analysis instructions.
    listings = [{
        "id": "1", "title": "t", "price": "$1", "location": "l",
        "user_context": "rust on frame",
        "profile_prompt": "must be full suspension",
        "_image_paths": ["/tmp/x.jpg"],
    }]
    out = build_user_prompt(listings)
    notes_pos = out.find("<user_notes>")
    crit_pos = out.find("<criteria>")
    photos_pos = out.find("<photos>")
    assert -1 < notes_pos < crit_pos < photos_pos


def test_build_user_prompt_trip_block_only_when_set():
    no_trip = build_user_prompt([{"id": "1", "title": "t", "price": "$1", "location": "l"}])
    assert "<distance_miles>" not in no_trip
    with_trip = build_user_prompt([{
        "id": "1", "title": "t", "price": "$1", "location": "l",
        "distance_miles": 5.2, "round_trip_gas_cost": 2.10,
    }])
    assert "<distance_miles>5.2</distance_miles>" in with_trip
    assert "<round_trip_gas_cost>2.1</round_trip_gas_cost>" in with_trip


# --- evaluate_parallel_streaming ------------------------------------------

def test_empty_listings_calls_done_with_none():
    verdicts: list = []
    dones: list = []
    evaluate_parallel_streaming([], "/usr/bin/claude", CostParams(),
                                 verdicts.append, dones.append)
    assert verdicts == []
    assert dones == [None]


def test_single_chunk_streams_all_verdicts(isolated_dirs):
    listings = _listings(3)
    fake = _ChunkResult(verdicts=[
        {"id": "0", "verdict": "good", "reason": "ok"},
        {"id": "1", "verdict": "skip", "reason": "no"},
        {"id": "2", "verdict": "fair", "reason": "maybe"},
    ], sent_ids=["0", "1", "2"])
    verdicts: list = []
    dones: list = []
    with patch("marketplace_watcher.claude_runner._run_chunk", return_value=fake):
        evaluate_parallel_streaming(listings, "/usr/bin/claude", CostParams(),
                                     verdicts.append, dones.append)
    assert {v["id"] for v in verdicts} == {"0", "1", "2"}
    assert dones == [None]


def test_multiple_chunks_streams_all_verdicts_in_arrival_order(isolated_dirs):
    # CHUNK_SIZE listings per chunk → request 2*CHUNK_SIZE forces 2 chunks.
    listings = _listings(CHUNK_SIZE * 2)

    def fake_run(chunk, *_args, **_kwargs):
        return _ChunkResult(verdicts=[
            {"id": item["id"], "verdict": "good", "reason": "ok"} for item in chunk
        ], sent_ids=[item["id"] for item in chunk])

    verdicts: list = []
    dones: list = []
    with patch("marketplace_watcher.claude_runner._run_chunk", side_effect=fake_run):
        evaluate_parallel_streaming(listings, "/usr/bin/claude", CostParams(),
                                     verdicts.append, dones.append)
    assert {v["id"] for v in verdicts} == {str(i) for i in range(CHUNK_SIZE * 2)}
    assert dones == [None]


def test_partial_chunk_failure_keeps_successful_verdicts(isolated_dirs):
    listings = _listings(CHUNK_SIZE * 2)
    call_count = {"n": 0}

    def fake_run(chunk, *_args, **_kwargs):
        call_count["n"] += 1
        if call_count["n"] == 1:
            return _ChunkResult(
                error="claude blew up", error_code="claude_failed",
                sent_ids=[item["id"] for item in chunk],
            )
        return _ChunkResult(verdicts=[
            {"id": item["id"], "verdict": "good", "reason": "ok"} for item in chunk
        ], sent_ids=[item["id"] for item in chunk])

    verdicts: list = []
    dones: list = []
    with patch("marketplace_watcher.claude_runner._run_chunk", side_effect=fake_run):
        evaluate_parallel_streaming(listings, "/usr/bin/claude", CostParams(),
                                     verdicts.append, dones.append)

    # CHUNK_SIZE successful verdicts streamed; on_done fires once with the
    # first error.
    assert len(verdicts) == CHUNK_SIZE
    assert len(dones) == 1
    assert dones[0] is not None
    assert dones[0]["code"] == "claude_failed"
    assert "claude blew up" in dones[0]["message"]


def test_all_chunks_fail_emits_done_with_first_error(isolated_dirs):
    listings = _listings(CHUNK_SIZE * 2)
    err = _ChunkResult(error="timed out", error_code="claude_timeout",
                       sent_ids=["0"])
    verdicts: list = []
    dones: list = []
    with patch("marketplace_watcher.claude_runner._run_chunk", return_value=err):
        evaluate_parallel_streaming(listings, "/usr/bin/claude", CostParams(),
                                     verdicts.append, dones.append)
    assert verdicts == []
    assert len(dones) == 1
    assert dones[0]["code"] == "claude_timeout"


def test_done_fires_exactly_once(isolated_dirs):
    # Critic-pass guard: with as_completed semantics, the wrong design would
    # fire on_done from each chunk worker — verify only once.
    listings = _listings(CHUNK_SIZE * 3)

    def fake_run(chunk, *_args, **_kwargs):
        return _ChunkResult(verdicts=[
            {"id": item["id"], "verdict": "fair", "reason": "ok"} for item in chunk
        ], sent_ids=[item["id"] for item in chunk])

    dones: list = []
    with patch("marketplace_watcher.claude_runner._run_chunk", side_effect=fake_run):
        evaluate_parallel_streaming(listings, "/usr/bin/claude", CostParams(),
                                     lambda v: None, dones.append)
    assert len(dones) == 1
