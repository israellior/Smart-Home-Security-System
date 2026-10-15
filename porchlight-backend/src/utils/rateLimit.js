/**
 * A counter with a window on it. Nothing more.
 *
 * Used by the claim endpoint, where a short secret is submitted by an
 * anonymous-ish guess: a six-character claim code is 887 million values,
 * which is far too many to type and not many at all to script. Login and
 * register use it too, for the same reason with a human-chosen secret.
 *
 * In memory, and deliberately no Redis. It is the same single-process
 * assumption presence and the talk floor already make, and it is worth
 * being precise about what that costs. With two app servers a guesser
 * gets one bucket per instance, so N servers multiply the ceiling by N -
 * which still leaves a limit, just a looser one. The thing that actually
 * makes guessing uneconomic is the keyspace plus the code being consumed
 * on first use; this is the layer that stops someone from walking the
 * keyspace in an afternoon. Trading a hard guarantee for no new
 * infrastructure is the right side of that line here. For passwords it is
 * closer: with N servers a guesser gets N times the login budget, and the
 * day there are several, these buckets belong in the database or Redis.
 *
 * Fixed windows, not sliding: a burst straddling a boundary can get 2x
 * the limit, which for a control whose job is to turn "millions of
 * guesses" into "dozens" does not matter.
 */

const buckets = new Map(); // name -> Map(key -> { count, resetAt })

// Swept lazily on write rather than on a timer, so an idle process holds
// no interval and a busy one pays a few microseconds. Without it, the key
// space here is "every claim code anyone ever submitted", which is
// attacker-controlled and would grow without limit.
const SWEEP_EVERY = 500;
let writes = 0;

function sweep(now) {
  for (const [, keys] of buckets) {
    for (const [key, entry] of keys) {
      if (entry.resetAt <= now) keys.delete(key);
    }
  }
}

/**
 * Counts one attempt against `name`/`key`.
 *
 * Returns { allowed, remaining, retryAfterMs }. Callers that only want to
 * charge for *failures* should call this after the check, not before -
 * see the claim controller, where a person fumbling their own valid code
 * should not be locked out by their own success.
 */
export function consume(name, key, { limit, windowMs }) {
  const now = Date.now();

  if (++writes % SWEEP_EVERY === 0) sweep(now);

  let keys = buckets.get(name);
  if (!keys) {
    keys = new Map();
    buckets.set(name, keys);
  }

  let entry = keys.get(key);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + windowMs };
    keys.set(key, entry);
  }

  entry.count++;
  const allowed = entry.count <= limit;

  return {
    allowed,
    remaining: Math.max(0, limit - entry.count),
    retryAfterMs: allowed ? 0 : entry.resetAt - now
  };
}

/**
 * Asks whether `name`/`key` is already over its limit, without charging
 * for asking. For callers that only charge failures but must still turn
 * a caller away *before* doing the expensive check - login, where the
 * check is a bcrypt compare and refusing after it would hand a guesser
 * the CPU anyway.
 */
export function peek(name, key, { limit }) {
  const entry = buckets.get(name)?.get(key);
  const now = Date.now();
  if (!entry || entry.resetAt <= now) return { allowed: true, retryAfterMs: 0 };

  const allowed = entry.count < limit;
  return { allowed, retryAfterMs: allowed ? 0 : entry.resetAt - now };
}

/** Forgets one key - what a success calls, so it costs nothing later. */
export function forget(name, key) {
  buckets.get(name)?.delete(key);
}

/** Tests and a restarted process both want this. */
export function clearAll() {
  buckets.clear();
}
