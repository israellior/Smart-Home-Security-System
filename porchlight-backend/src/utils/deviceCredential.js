import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * Credentials and pairing codes for real hardware.
 *
 * Two different secrets with two different jobs, and they are easy to
 * confuse:
 *
 *   pairing code - short, human-typed, single use, expires in minutes.
 *                  Proves "the person holding this screen also has
 *                  physical access to this Pi".
 *   credential   - long, machine-held, long-lived. Proves "I am porch-1"
 *                  on every request the daemon ever makes.
 *
 * The share code in utils/shareCode.js is a third thing again: it grants
 * a *person* access to a doorbell. None of the three substitute for each
 * other.
 */

// A credential looks like:  pl_porch-1_<43 url-safe chars>
//
// The deviceId rides inside the credential deliberately. A bare secret
// would force the server to hash-compare against every device row just to
// learn who is calling; carrying the id makes authentication one indexed
// lookup plus one hash, whatever the size of the fleet. It is the same
// reason GitHub and Stripe keys are prefixed rather than opaque.
const CREDENTIAL_PREFIX = 'pl';
const SECRET_BYTES = 32;

// Pairing codes are read off one screen and typed into another machine,
// so they reuse the transcription-safe alphabet share codes use - no
// 0/O, no 1/I/L.
const PAIRING_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PAIRING_LENGTH = 8;
const PAIRING_PREFIX = 'PAIR';

// Long enough to walk to the doorbell and type it in, short enough that a
// code left on a screen overnight is worthless. 31^8 is ~850 billion, so
// the expiry is defence in depth rather than the only thing standing in
// the way.
export const PAIRING_TTL_MS = 10 * 60 * 1000;

// Lowercase slug: it appears in URLs, in LiveKit room names, and inside
// the credential itself, where an underscore would break parsing.
const DEVICE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,31}$/;

export function isValidDeviceId(value) {
  return DEVICE_ID_PATTERN.test(String(value ?? ''));
}

export function normalizeDeviceId(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

/**
 * Device secrets are hashed with SHA-256, not bcrypt. That is a decision,
 * not a shortcut.
 *
 * bcrypt is slow on purpose, and the slowness buys exactly one thing:
 * making a guess against a *human-chosen* password expensive. A device
 * credential is 32 bytes straight from the OS CSPRNG. There is no
 * dictionary to run against it, and no amount of stretching improves on
 * 256 bits of entropy. What the slowness would cost is real - roughly
 * 100ms added to every media-token mint, every clip upload and every
 * socket reconnect, on every doorbell in the fleet.
 *
 * User passwords keep bcryptjs (see models/User.js). The rule is about
 * the entropy of the secret, not about which collection it lives in.
 */
function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

/**
 * Mints a fresh credential for a device. Returns the plaintext once -
 * the caller is expected to hand it to the Pi and forget it, because
 * only the hash is ever stored. A credential that is lost is re-paired,
 * never looked up.
 */
export function generateDeviceCredential(deviceId) {
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  return {
    credential: `${CREDENTIAL_PREFIX}_${deviceId}_${secret}`,
    credentialHash: sha256(secret)
  };
}

/**
 * Splits a presented credential back into the two halves the lookup
 * needs. Returns null for anything malformed, so callers get one "no"
 * rather than having to reason about partial parses.
 *
 * Scanned strictly left to right, and that is the whole subtlety here.
 * base64url's alphabet is A-Z a-z 0-9 - _ : it *includes* the underscore,
 * so a secret routinely contains separators of its own and splitting from
 * the right cuts the secret in half. The prefix and the deviceId are the
 * two fields that provably cannot contain one - DEVICE_ID_PATTERN forbids
 * it - so the first two underscores are the only ones that are
 * structural. Everything after the second is secret, verbatim.
 */
export function parseDeviceCredential(raw) {
  const value = String(raw ?? '');

  const firstSep = value.indexOf('_');
  if (firstSep <= 0) return null;

  const secondSep = value.indexOf('_', firstSep + 1);
  if (secondSep <= firstSep + 1) return null;

  const prefix = value.slice(0, firstSep);
  const deviceId = value.slice(firstSep + 1, secondSep);
  const secret = value.slice(secondSep + 1);

  if (prefix !== CREDENTIAL_PREFIX || !secret || !isValidDeviceId(deviceId)) return null;
  return { deviceId, secret };
}

/**
 * Constant-time comparison. Both sides are fixed-length hex digests here,
 * so the length guard should never fire - it is there because
 * timingSafeEqual throws on a length mismatch, and a device presenting a
 * garbage credential should get a clean 401 rather than crash the
 * request.
 */
export function secretMatchesHash(secret, storedHash) {
  if (!storedHash) return false;
  const presented = Buffer.from(sha256(secret), 'utf8');
  const stored = Buffer.from(String(storedHash), 'utf8');
  if (presented.length !== stored.length) return false;
  return timingSafeEqual(presented, stored);
}

/**
 * A one-time code the owner reads off the app and types into the Pi.
 * randomInt rather than Math.random for the same reason share codes use
 * it: this is a credential, and Math.random is seeded predictably.
 */
export function generatePairingCode() {
  let body = '';
  for (let i = 0; i < PAIRING_LENGTH; i++) {
    body += PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)];
  }
  const code = `${PAIRING_PREFIX}-${body}`;
  return {
    code,
    codeHash: hashPairingCode(code),
    expiresAt: new Date(Date.now() + PAIRING_TTL_MS)
  };
}

/** Accepts what a human types - "pair 7k2m9p4q", "PAIR-7K2M9P4Q", spaces. */
export function normalizePairingCode(input) {
  const cleaned = String(input ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

  const body = cleaned.startsWith(PAIRING_PREFIX) ? cleaned.slice(PAIRING_PREFIX.length) : cleaned;
  return body ? `${PAIRING_PREFIX}-${body}` : '';
}

/**
 * Pairing codes are looked up *by* their hash - the server has no idea
 * which device a presented code belongs to until it finds it. So unlike
 * the credential, this hash has to be deterministic and indexable, which
 * is another reason bcrypt (salted, so unindexable) is the wrong tool
 * here.
 */
export function hashPairingCode(code) {
  return sha256(code);
}
