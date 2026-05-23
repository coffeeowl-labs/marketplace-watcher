// content/batcher.js — auto-commit batcher state machine.
//
// Owns the per-tab state for each listing the user has selected via the
// picker, and orchestrates the pipeline that used to start at the
// Analyze button click. Picker change → 2s undo debounce → scrape →
// queued → (MIN/MAX batch + idle quiescence) → ship → claude → verdict.
//
// Lives in the content script so the state dies with the tab — matches
// the user's mental model (queued items are session-scoped, not a
// durable commitment) and avoids background-event-page suspension
// hazards. Background stays stateless transport.
//
// State transitions are: commit → PENDING_UNDO → (undo elapses) → SCRAPING
// → QUEUED → (batch + idle satisfied) → EVALUATING → DONE (verdict in)
// or ERROR (any failure). cancel() removes the entry entirely; a
// PROFILE change on an EVALUATING entry aborts the chunk and re-queues
// peers per the critic's "atomic chunk = atomic invalidation" rule.

const MW_BATCHER = (() => {
  const MIN_BATCH = 3;
  const MAX_BATCH = 5;
  const UNDO_MS = 2000;
  const IDLE_WINDOW_MS = 2000;
  const CONCURRENCY_CAP = 2;

  const S = Object.freeze({
    PENDING_UNDO: "pending-undo",
    SCRAPING: "scraping",
    QUEUED: "queued",
    EVALUATING: "evaluating",
    DONE: "done",
    ERROR: "error",
  });

  // Per-listing entry. Fields are documented inline at the assignment sites.
  const entries = new Map();
  // requestId -> Set<id> for chunk membership, used when a profile change
  // mid-evaluation needs to re-enqueue peers.
  const chunkMembers = new Map();

  let activeChunks = 0;
  let idleTimer = null;
  // True only between "idle timer fired" and "next attemptShip consumes it".
  // Lets a single attemptShip path decide whether to arm or to ship now.
  let idleExpired = false;
  let onChangeCb = null;
  let includeImagesDefault = false;

  // First-commit-per-tab gates — done once and cached.
  let healthChecked = false;
  let healthOK = false;
  let healthPromise = null;

  // ---- Public API ---------------------------------------------------------

  function init({ onChange, includeImagesDefault: incl }) {
    onChangeCb = onChange;
    includeImagesDefault = !!incl;
  }

  function getEntry(id) {
    return entries.get(id);
  }

  function snapshot() {
    return Array.from(entries.entries()).map(([id, e]) => ({ id, ...e }));
  }

  function commit(id, profileId) {
    const prior = entries.get(id);
    if (prior) {
      if (prior.state === S.EVALUATING) {
        // Profile change mid-flight: abort the chunk, re-queue peers.
        // The new commit below replaces this listing's entry; peers go
        // back to QUEUED with their existing scrape data.
        abortChunkForProfileChange(prior.requestId, id);
      } else if (prior.state === S.PENDING_UNDO && prior.undoTimer) {
        clearTimeout(prior.undoTimer);
      }
      // SCRAPING: the in-flight scrape resolves into a stale entry; the
      // epoch check in onUndoExpired-tail discards it. New entry below
      // starts a fresh scrape attempt (scrape-side cache will hit so it's
      // cheap).
      // QUEUED, DONE, ERROR: just replace.
    }
    const epoch = (prior?.epoch || 0) + 1;
    const entry = {
      state: S.PENDING_UNDO,
      profileId,
      epoch,
      undoTimer: setTimeout(() => onUndoExpired(id, epoch), UNDO_MS),
    };
    entries.set(id, entry);
    emit(id);
    attemptShip();

    if (!healthChecked && !healthPromise) {
      healthPromise = runHealthCheck();
    }
  }

  function cancel(id) {
    const entry = entries.get(id);
    if (!entry) return;
    if (entry.state === S.EVALUATING) {
      abortChunkForProfileChange(entry.requestId, id);
    } else if (entry.state === S.PENDING_UNDO && entry.undoTimer) {
      clearTimeout(entry.undoTimer);
    }
    entries.delete(id);
    emit(id);
    attemptShip();
  }

  function stopAll() {
    const requestIds = Array.from(chunkMembers.keys());
    for (const rid of requestIds) sendCancelBatch(rid);
    chunkMembers.clear();
    activeChunks = 0;

    const ids = Array.from(entries.keys());
    for (const id of ids) {
      const e = entries.get(id);
      if (e.state === S.PENDING_UNDO && e.undoTimer) clearTimeout(e.undoTimer);
      entries.delete(id);
      emit(id);
    }
    disarmIdle();
  }

  function handleVerdict(verdict) {
    if (!verdict || !verdict.id) return;
    const entry = entries.get(verdict.id);
    if (!entry || entry.state !== S.EVALUATING) return;
    entry.state = S.DONE;
    entry.verdict = verdict;
    if (entry.requestId) {
      const members = chunkMembers.get(entry.requestId);
      if (members) members.delete(verdict.id);
    }
    emit(verdict.id);
  }

  function handleBatchDone(requestId, error) {
    const members = chunkMembers.get(requestId);
    chunkMembers.delete(requestId);
    activeChunks = Math.max(0, activeChunks - 1);

    if (members) {
      // Listings still in EVALUATING (no verdict received) — surface as
      // error so the user knows to retry.
      for (const id of members) {
        const e = entries.get(id);
        if (!e || e.state !== S.EVALUATING) continue;
        e.state = S.ERROR;
        e.errorMessage = error
          ? error.message || "Batch failed"
          : "No verdict returned";
        emit(id);
      }
    }
    attemptShip();
  }

  // ---- Internal transitions ----------------------------------------------

  async function onUndoExpired(id, epoch) {
    const entry = entries.get(id);
    if (!entry || entry.epoch !== epoch || entry.state !== S.PENDING_UNDO) return;
    entry.undoTimer = null;

    if (!healthChecked) {
      try {
        healthOK = await healthPromise;
      } catch (_) {
        healthOK = false;
      }
      healthChecked = true;
      healthPromise = null;
    }
    if (!isCurrent(id, entry)) return;
    if (!healthOK) {
      entry.state = S.ERROR;
      entry.errorMessage =
        "Helper unreachable — run `marketplace-watcher doctor` to diagnose.";
      emit(id);
      attemptShip();
      return;
    }

    const stored = (await chrome.storage.local.get("user_location")).user_location;
    if (!isCurrent(id, entry)) return;
    if (!stored || !stored.raw) {
      entry.state = S.ERROR;
      entry.errorMessage = "Set your location first.";
      emit(id);
      attemptShip();
      return;
    }

    entry.state = S.SCRAPING;
    emit(id);
    attemptShip(); // SCRAPING disarms idle.

    let resp;
    try {
      resp = await chrome.runtime.sendMessage({ type: "scrape", listingId: id });
    } catch (e) {
      if (!isCurrent(id, entry)) return;
      entry.state = S.ERROR;
      entry.errorMessage = e.message || String(e);
      emit(id);
      attemptShip();
      return;
    }
    if (!isCurrent(id, entry)) return;
    if (!resp || !resp.ok) {
      entry.state = S.ERROR;
      entry.errorMessage = (resp && resp.error) || "Scrape failed";
      emit(id);
      attemptShip();
      return;
    }
    entry.scrapeData = resp.data;
    entry.state = S.QUEUED;
    emit(id);
    attemptShip();
  }

  function isCurrent(id, entry) {
    return entries.get(id) === entry;
  }

  function attemptShip() {
    if (activeChunks >= CONCURRENCY_CAP) {
      disarmIdle();
      return;
    }

    let queuedIds = [];
    let pendingCount = 0;
    for (const [id, e] of entries) {
      if (e.state === S.QUEUED) queuedIds.push(id);
      else if (e.state === S.PENDING_UNDO || e.state === S.SCRAPING) {
        pendingCount += 1;
      }
    }

    // Anything in pending/scraping disarms idle — wait for quiescence.
    if (pendingCount > 0) {
      disarmIdle();
      return;
    }

    if (queuedIds.length === 0) {
      disarmIdle();
      return;
    }

    if (queuedIds.length >= MAX_BATCH) {
      shipBatch(queuedIds.slice(0, MAX_BATCH));
      return;
    }

    // Below MAX, no pending — eligible to ship if MIN met and idle elapsed.
    if (queuedIds.length >= MIN_BATCH) {
      if (idleExpired) {
        disarmIdle();
        shipBatch(queuedIds.slice(0, MAX_BATCH));
        return;
      }
      armIdle();
      return;
    }

    // Below MIN, nothing incoming — silent terminal state ("waiting —
    // 3-listing minimum" badge surfaces this).
    disarmIdle();
  }

  function armIdle() {
    if (idleTimer || idleExpired) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      idleExpired = true;
      attemptShip();
    }, IDLE_WINDOW_MS);
  }

  function disarmIdle() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    idleExpired = false;
  }

  function shipBatch(ids) {
    activeChunks += 1;
    const requestId = crypto.randomUUID();
    chunkMembers.set(requestId, new Set(ids));

    const items = ids.map((id) => {
      const entry = entries.get(id);
      entry.state = S.EVALUATING;
      entry.requestId = requestId;
      emit(id);
      return {
        id,
        profileId: entry.profileId,
        scrapeData: entry.scrapeData,
      };
    });

    chrome.runtime
      .sendMessage({
        type: "ship_batch",
        requestId,
        items,
        includeImages: includeImagesDefault,
      })
      .catch((e) => {
        handleBatchDone(requestId, { message: e.message || String(e) });
      });

    // Another chunk may be eligible immediately (we just freed the queued
    // slots and may still be under the cap with more queued).
    setTimeout(attemptShip, 0);
  }

  function abortChunkForProfileChange(requestId, triggerId) {
    if (!requestId) return;
    sendCancelBatch(requestId);
    const members = chunkMembers.get(requestId);
    chunkMembers.delete(requestId);
    activeChunks = Math.max(0, activeChunks - 1);
    if (!members) return;
    for (const id of members) {
      if (id === triggerId) continue;
      const e = entries.get(id);
      if (!e || e.state !== S.EVALUATING) continue;
      // Already-DONE peers keep their verdict. Mid-flight peers go back
      // to QUEUED with their original scrape data + profile.
      e.state = S.QUEUED;
      e.requestId = undefined;
      emit(id);
    }
    attemptShip();
  }

  function sendCancelBatch(requestId) {
    chrome.runtime
      .sendMessage({ type: "cancel_batch", requestId })
      .catch(() => {});
  }

  function runHealthCheck() {
    return chrome.runtime
      .sendMessage({ type: "check_health" })
      .then((resp) => !!(resp && resp.ok))
      .catch(() => false);
  }

  function emit(id) {
    if (!onChangeCb) return;
    try {
      onChangeCb(id, entries.get(id) || null);
    } catch (_) {}
  }

  function countByState() {
    const c = { pending: 0, scraping: 0, queued: 0, evaluating: 0, done: 0, error: 0 };
    for (const e of entries.values()) {
      if (e.state === S.PENDING_UNDO) c.pending += 1;
      else if (e.state === S.SCRAPING) c.scraping += 1;
      else if (e.state === S.QUEUED) c.queued += 1;
      else if (e.state === S.EVALUATING) c.evaluating += 1;
      else if (e.state === S.DONE) c.done += 1;
      else if (e.state === S.ERROR) c.error += 1;
    }
    return c;
  }

  function activeCount() {
    let n = 0;
    for (const e of entries.values()) {
      if (e.state === S.PENDING_UNDO || e.state === S.SCRAPING ||
          e.state === S.QUEUED || e.state === S.EVALUATING) n += 1;
    }
    return n;
  }

  return {
    STATES: S,
    MIN_BATCH,
    MAX_BATCH,
    init,
    commit,
    cancel,
    stopAll,
    handleVerdict,
    handleBatchDone,
    getEntry,
    snapshot,
    countByState,
    activeCount,
  };
})();
