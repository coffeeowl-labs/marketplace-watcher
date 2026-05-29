// Zero-dep harness for loading extension/content/batcher.js into a
// sandboxed Node context. The batcher is written as a content-script
// IIFE; here we just inject the globals it expects (chrome.*, crypto,
// timers) and read MW_BATCHER back out.
//
// Fake timers: the batcher uses setTimeout for the 2s undo debounce and
// the 2s idle quiescence window. Real timers make tests slow and racy;
// instead we hand it a fireOn-demand scheduler the test drives via
// `timers.fireNext()` / `timers.fireAll()`.
//
// Microtask flush: the batcher's onUndoExpired is async (awaits health,
// location, scrape). Calling timers.fireNext() runs the sync portion but
// leaves awaits suspended — `await flush()` yields the event loop enough
// times for those to resolve before assertions run.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function makeFakeTimers() {
  const timers = new Map(); // id -> { fn, ms, at }
  let nextId = 1;
  let now = 0;
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, ms, at: now + ms });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    pending() { return timers.size; },
    fireNext() {
      if (timers.size === 0) return false;
      // Fire the soonest-scheduled.
      let chosen = null;
      for (const [id, t] of timers) {
        if (!chosen || t.at < chosen.t.at) chosen = { id, t };
      }
      timers.delete(chosen.id);
      now = chosen.t.at;
      chosen.t.fn();
      return true;
    },
    async fireAll(flush) {
      // Useful when test wants to drain everything (e.g. after stopAll).
      // Microtask flush after each fire so async handlers settle.
      while (timers.size > 0) {
        this.fireNext();
        if (flush) await flush();
      }
    },
  };
}

async function flush() {
  // Empirically ~10 cycles is enough for batcher.js's longest await chain
  // (commit → onUndoExpired → await health → await location → await scrape).
  // Bump if a test starts flaking.
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function loadBatcher({ messages = {}, storage = {} } = {}) {
  const messageLog = [];
  const sendMessage = (msg) => {
    messageLog.push(msg);
    const handler = messages[msg.type];
    // sendMessage returns a Promise in MV3 — preserve that shape.
    if (handler) return Promise.resolve(handler(msg));
    return Promise.resolve({ ok: true });
  };
  const storageGet = (key) => {
    if (typeof key === "string") {
      return Promise.resolve({ [key]: storage[key] });
    }
    const result = {};
    for (const k of key) result[k] = storage[k];
    return Promise.resolve(result);
  };

  const timers = makeFakeTimers();
  const context = {
    chrome: {
      runtime: { sendMessage },
      storage: { local: { get: storageGet } },
    },
    crypto: globalThis.crypto,
    setTimeout: timers.setTimeout.bind(timers),
    clearTimeout: timers.clearTimeout.bind(timers),
    // Pass through real built-ins the batcher uses.
    Date, Math, JSON, console, Promise,
    Map, Set, Array, Object, Symbol, Error, Number, String, Boolean,
  };
  vm.createContext(context);
  const code = fs.readFileSync(
    path.join(__dirname, "..", "extension", "content", "batcher.js"),
    "utf8"
  );
  // The batcher uses `const MW_BATCHER = ...` at top level. In a vm
  // context, `const` lives in script scope and is NOT a property of the
  // context object — so we append an explicit export to make it visible
  // to the harness without modifying the production source.
  vm.runInContext(code + "\n;globalThis.__mw_batcher_export = MW_BATCHER;", context);
  return { batcher: context.__mw_batcher_export, messageLog, timers };
}

function messagesByType(messageLog, type) {
  return messageLog.filter((m) => m.type === type);
}

// Pull the latest entry state from the batcher's snapshot. Convenience for
// assertions; the batcher's getEntry() is the canonical accessor but
// snapshot() is easier to inspect in test failure output.
function entryById(batcher, id) {
  return batcher.snapshot().find((e) => e.id === id);
}

module.exports = { loadBatcher, flush, messagesByType, entryById };
