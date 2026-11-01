// Limits for model questions (chat plan section 13, step 5): CHAT_RATE_PER_HOUR per user in a
// rolling hour, and one model call in flight with at most one waiting for the whole dashboard.
// State is kept in memory per app; a restart of the dashboard clears it.
const HOUR_MS = 60 * 60 * 1000;

function createLimits({ perHour = 20, now = Date.now } = {}) {
  const used = new Map(); // user id -> times of model questions, oldest first
  let inFlight = false;
  const waiting = []; // resolve functions, at most one

  function recent(userId) {
    const cutoff = now() - HOUR_MS;
    const list = (used.get(userId) || []).filter((t) => t > cutoff);
    if (list.length) used.set(userId, list);
    else used.delete(userId);
    return list;
  }

  // { ok: true } or { ok: false, nextFreeAt } with the time the oldest question leaves the hour.
  function checkRate(userId) {
    const list = recent(userId);
    if (list.length < perHour) return { ok: true };
    return { ok: false, nextFreeAt: list[list.length - perHour] + HOUR_MS };
  }

  function consume(userId) {
    const list = recent(userId);
    list.push(now());
    used.set(userId, list);
  }

  function left(userId) {
    return Math.max(0, perHour - recent(userId).length);
  }

  function release() {
    const next = waiting.shift();
    if (next) next();
    else inFlight = false;
  }

  // Resolves with a release function once the slot is free, or returns null at once when one call
  // is running and another is already waiting.
  function acquire() {
    if (!inFlight) {
      inFlight = true;
      return Promise.resolve(once(release));
    }
    if (waiting.length >= 1) return null;
    return new Promise((resolve) => waiting.push(() => resolve(once(release))));
  }

  return { checkRate, consume, left, acquire, perHour };
}

function once(fn) {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    fn();
  };
}

module.exports = { createLimits, HOUR_MS };
