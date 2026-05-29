// Batcher state-machine tests. The risky paths that motivated this
// harness are the ones the second critic pass flagged: idle quiescence
// detection, profile-change-during-evaluating, concurrency cap, peer
// re-queue, sub-MIN silent wait. Cover those explicitly; lighter
// coverage on the obvious happy paths.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
  loadBatcher,
  flush,
  messagesByType,
  entryById,
} = require("./helpers.js");

const VALID_LOC = { raw: "97401" };
const HEALTHY = { type: "check_health", ok: true };

// Sets up a batcher that has location set, health passes, and scrape
// returns a synthetic body. Tests that need other behavior override
// these stubs.
function defaultSetup({ scrapeOverride, healthOverride } = {}) {
  return loadBatcher({
    storage: { user_location: VALID_LOC },
    messages: {
      check_health: healthOverride || (() => ({ ok: true })),
      scrape: scrapeOverride || ((m) => ({
        ok: true,
        data: {
          title: `Listing ${m.listingId}`,
          price: "$100",
          location: "Eugene, OR",
          description: "some text",
        },
      })),
      ship_batch: () => ({ ok: true }),
      cancel_batch: () => ({ ok: true }),
    },
  });
}

// Walk a committed listing all the way through to QUEUED. The batcher
// does: PENDING_UNDO → (timer) → SCRAPING → (await scrape) → QUEUED. So
// we fire one timer (undo) and flush once.
async function pushToQueued(batcher, timers, id, profileId = "default") {
  batcher.commit(id, profileId);
  await flush();
  timers.fireNext(); // undo expires → onUndoExpired runs
  await flush();
}

// ----- happy paths -------------------------------------------------------

describe("commit flow", () => {
  test("single commit enters PENDING_UNDO synchronously", async () => {
    const { batcher } = defaultSetup();
    batcher.commit("a", "default");
    const e = entryById(batcher, "a");
    assert.equal(e.state, batcher.STATES.PENDING_UNDO);
    assert.equal(e.profileId, "default");
  });

  test("undo expiry transitions PENDING_UNDO → SCRAPING → QUEUED", async () => {
    const { batcher, timers } = defaultSetup();
    await pushToQueued(batcher, timers, "a");
    assert.equal(entryById(batcher, "a").state, batcher.STATES.QUEUED);
  });
});

// ----- sub-MIN silent wait ----------------------------------------------

describe("sub-MIN batches", () => {
  test("solo selection never ships", async () => {
    const { batcher, timers, messageLog } = defaultSetup();
    await pushToQueued(batcher, timers, "a");
    // Drain any idle timers — there shouldn't be one armed below MIN.
    await timers.fireAll(flush);
    await flush();
    assert.equal(
      messagesByType(messageLog, "ship_batch").length, 0,
      "must not ship below MIN_BATCH"
    );
    assert.equal(entryById(batcher, "a").state, batcher.STATES.QUEUED);
  });

  test("two queued never ships", async () => {
    const { batcher, timers, messageLog } = defaultSetup();
    await pushToQueued(batcher, timers, "a");
    await pushToQueued(batcher, timers, "b");
    await timers.fireAll(flush);
    await flush();
    assert.equal(messagesByType(messageLog, "ship_batch").length, 0);
  });
});

// ----- batch + idle ------------------------------------------------------

describe("ship triggers", () => {
  test("MAX_BATCH=5 queued ships immediately (no idle wait)", async () => {
    const { batcher, timers, messageLog } = defaultSetup();
    for (const id of ["a", "b", "c", "d", "e"]) {
      await pushToQueued(batcher, timers, id);
    }
    await flush();
    const ships = messagesByType(messageLog, "ship_batch");
    assert.equal(ships.length, 1);
    assert.equal(ships[0].items.length, 5);
    // No idle timer should be pending (we shipped immediately).
    // Note: there may still be the post-ship setTimeout(attemptShip, 0).
    // Fire any remaining and confirm no second ship.
    await timers.fireAll(flush);
    assert.equal(messagesByType(messageLog, "ship_batch").length, 1);
  });

  test("MIN met + idle window elapses → ships", async () => {
    const { batcher, timers, messageLog } = defaultSetup();
    await pushToQueued(batcher, timers, "a");
    await pushToQueued(batcher, timers, "b");
    await pushToQueued(batcher, timers, "c");
    // Now batcher should have armed the idle timer. Fire it.
    assert.equal(messagesByType(messageLog, "ship_batch").length, 0);
    timers.fireNext(); // idle expires
    await flush();
    const ships = messagesByType(messageLog, "ship_batch");
    assert.equal(ships.length, 1);
    assert.equal(ships[0].items.length, 3);
  });
});

// ----- quiescence: pending/scraping must block idle ship -----------------

describe("idle quiescence", () => {
  test("scraping listing prevents idle ship of 3 queued", async () => {
    // 3 queued + 1 still scraping should NOT trigger idle ship — the
    // pending one is incoming and should be allowed to join.
    const { batcher, timers, messageLog } = defaultSetup({
      // Make the 4th listing's scrape hang (never resolves) so it stays
      // in SCRAPING state.
      scrapeOverride: (m) => {
        if (m.listingId === "slow") return new Promise(() => {});
        return {
          ok: true,
          data: {
            title: "x", price: "$1", location: "y", description: "z",
          },
        };
      },
    });
    await pushToQueued(batcher, timers, "a");
    await pushToQueued(batcher, timers, "b");
    await pushToQueued(batcher, timers, "c");

    // Now commit a 4th. It'll go PENDING_UNDO; fire its undo timer to
    // get it to SCRAPING (which will hang).
    batcher.commit("slow", "default");
    await flush();
    timers.fireNext(); // undo expires → SCRAPING
    await flush();
    assert.equal(entryById(batcher, "slow").state, batcher.STATES.SCRAPING);

    // Now fire any remaining timers — there should be NO idle timer
    // armed because something is still scraping. So no ship.
    await timers.fireAll(flush);
    assert.equal(
      messagesByType(messageLog, "ship_batch").length, 0,
      "idle must not fire while a peer is still scraping"
    );
  });
});

// ----- cancel / stop-all -------------------------------------------------

describe("cancel paths", () => {
  test("cancel during PENDING_UNDO clears the entry, no scrape sent", async () => {
    const { batcher, timers, messageLog } = defaultSetup();
    batcher.commit("a", "default");
    assert.equal(entryById(batcher, "a").state, batcher.STATES.PENDING_UNDO);
    batcher.cancel("a");
    assert.equal(entryById(batcher, "a"), undefined);
    // Fire any pending timers — the cleared undo timer should be gone,
    // but defensively confirm no scrape ever fired.
    await timers.fireAll(flush);
    assert.equal(messagesByType(messageLog, "scrape").length, 0);
  });

  test("stopAll cancels in-flight chunk and clears everything", async () => {
    const { batcher, timers, messageLog } = defaultSetup();
    await pushToQueued(batcher, timers, "a");
    await pushToQueued(batcher, timers, "b");
    await pushToQueued(batcher, timers, "c");
    await pushToQueued(batcher, timers, "d");
    await pushToQueued(batcher, timers, "e");
    await flush();
    // 5 queued → ship fired immediately. Now stopAll.
    assert.equal(messagesByType(messageLog, "ship_batch").length, 1);
    const ship = messagesByType(messageLog, "ship_batch")[0];

    batcher.stopAll();
    await flush();

    // cancel_batch must have been sent for that requestId.
    const cancels = messagesByType(messageLog, "cancel_batch");
    assert.equal(cancels.length, 1);
    assert.equal(cancels[0].requestId, ship.requestId);

    // All entries cleared.
    assert.equal(batcher.snapshot().length, 0);
  });
});

// ----- profile change during EVALUATING ---------------------------------

describe("profile change mid-evaluating (critic-flagged)", () => {
  test("re-commit on EVALUATING listing aborts chunk + re-queues peers", async () => {
    const { batcher, timers, messageLog } = defaultSetup();
    await pushToQueued(batcher, timers, "a");
    await pushToQueued(batcher, timers, "b");
    await pushToQueued(batcher, timers, "c");
    // 3 queued → arm idle. Fire idle.
    timers.fireNext();
    await flush();
    const ship = messagesByType(messageLog, "ship_batch")[0];
    assert.ok(ship, "first batch should have shipped");
    assert.equal(ship.items.length, 3);
    for (const id of ["a", "b", "c"]) {
      assert.equal(
        entryById(batcher, id).state, batcher.STATES.EVALUATING
      );
    }

    // Now the user changes b's profile mid-evaluation.
    batcher.commit("b", "profile-x");
    await flush();

    // cancel_batch must have been sent for the chunk.
    const cancels = messagesByType(messageLog, "cancel_batch");
    assert.equal(cancels.length, 1);
    assert.equal(cancels[0].requestId, ship.requestId);

    // Peers (a, c) must be re-queued, not orphaned in EVALUATING.
    assert.equal(entryById(batcher, "a").state, batcher.STATES.QUEUED);
    assert.equal(entryById(batcher, "c").state, batcher.STATES.QUEUED);
    // b restarts the lifecycle with the new profile.
    assert.equal(entryById(batcher, "b").state, batcher.STATES.PENDING_UNDO);
    assert.equal(entryById(batcher, "b").profileId, "profile-x");
  });
});

// ----- concurrency cap ---------------------------------------------------

describe("concurrency cap", () => {
  test("third full batch waits when 2 chunks already in flight", async () => {
    const { batcher, timers, messageLog } = defaultSetup();
    // Queue 10 listings; expect 2 batches of 5 to ship (cap=2), 3rd
    // batch worth would be 0 since 10 = 2*5 exactly. Re-test with 15.
    for (let i = 0; i < 15; i++) {
      await pushToQueued(batcher, timers, `id${i}`);
    }
    await flush();
    await timers.fireAll(flush);

    // Only 2 ship_batches should have fired (cap=2).
    const ships = messagesByType(messageLog, "ship_batch");
    assert.equal(ships.length, 2, "concurrency cap should hold third batch");
    assert.equal(ships[0].items.length, 5);
    assert.equal(ships[1].items.length, 5);

    // 5 listings should still be QUEUED, waiting.
    const queued = batcher.snapshot().filter(
      (e) => e.state === batcher.STATES.QUEUED
    );
    assert.equal(queued.length, 5);

    // Complete the first batch → 3rd batch ships.
    batcher.handleBatchDone(ships[0].requestId, null);
    await flush();
    await timers.fireAll(flush);
    const ships2 = messagesByType(messageLog, "ship_batch");
    assert.equal(ships2.length, 3, "freeing a chunk lets the 3rd ship");
  });
});

// ----- verdict handling --------------------------------------------------

describe("verdict + batch-done plumbing", () => {
  test("handleVerdict moves entry to DONE", async () => {
    const { batcher, timers, messageLog } = defaultSetup();
    for (const id of ["a", "b", "c", "d", "e"]) {
      await pushToQueued(batcher, timers, id);
    }
    await flush();
    const ship = messagesByType(messageLog, "ship_batch")[0];
    assert.equal(entryById(batcher, "a").state, batcher.STATES.EVALUATING);

    batcher.handleVerdict({ id: "a", verdict: "good", reason: "ok" });
    assert.equal(entryById(batcher, "a").state, batcher.STATES.DONE);
    assert.deepEqual(entryById(batcher, "a").verdict, {
      id: "a", verdict: "good", reason: "ok",
    });
  });

  test("batch_done with peers still EVALUATING marks them ERROR", async () => {
    const { batcher, timers, messageLog } = defaultSetup();
    for (const id of ["a", "b", "c", "d", "e"]) {
      await pushToQueued(batcher, timers, id);
    }
    await flush();
    const ship = messagesByType(messageLog, "ship_batch")[0];
    // Only "a" gets a verdict; rest hang.
    batcher.handleVerdict({ id: "a", verdict: "good", reason: "ok" });
    batcher.handleBatchDone(ship.requestId, { message: "host died" });

    assert.equal(entryById(batcher, "a").state, batcher.STATES.DONE);
    for (const id of ["b", "c", "d", "e"]) {
      const e = entryById(batcher, id);
      assert.equal(e.state, batcher.STATES.ERROR);
      assert.match(e.errorMessage, /host died/);
    }
  });
});

// ----- health + counts ---------------------------------------------------

describe("health gate", () => {
  test("failed health check at undo-expiry → entry transitions to ERROR", async () => {
    const { batcher, timers, messageLog } = defaultSetup({
      healthOverride: () => ({ ok: false }),
    });
    batcher.commit("a", "default");
    await flush();
    timers.fireNext(); // undo expires
    await flush();
    const e = entryById(batcher, "a");
    assert.equal(e.state, batcher.STATES.ERROR);
    assert.match(e.errorMessage, /Helper unreachable/);
    assert.equal(messagesByType(messageLog, "scrape").length, 0,
      "no scrape when health fails");
  });
});

describe("counts", () => {
  test("activeCount excludes DONE and ERROR", async () => {
    // Push to MAX_BATCH so the batch ships immediately and the entries
    // become EVALUATING — only then can handleVerdict transition them.
    const { batcher, timers } = defaultSetup();
    for (const id of ["a", "b", "c", "d", "e"]) {
      await pushToQueued(batcher, timers, id);
    }
    await flush();
    assert.equal(batcher.activeCount(), 5);
    batcher.handleVerdict({ id: "a", verdict: "good", reason: "ok" });
    assert.equal(batcher.activeCount(), 4, "DONE should not count");
  });
});
