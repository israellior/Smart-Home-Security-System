import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Device credentials - the secret a Raspberry Pi is built with.
 *
 * A device is provisioned once, by an operator running
 * scripts/mint-device.mjs, and the credential is written onto its SD card
 * alongside the rest of its configuration. It never enrols over the
 * network, never negotiates for a secret, and never takes part in
 * deciding who owns it. It boots, authenticates, and starts reporting.
 *
 * That separation is the point: authentication answers "is this a real
 * doorbell", ownership answers "whose is it", and only the second one
 * involves a person. A doorbell that comes up at 3am reports motion at
 * 3am, whether or not anyone has claimed it yet.
 *
 * The share code in utils/shareCode.js is the other half - it grants a
 * *person* access to a doorbell. The two never substitute for each other.
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
 * Mints a credential. Returns the plaintext once - the caller writes it
 * to the device and forgets it, because only the hash is stored. There is
 * no endpoint that reads it back and no recovery path: a credential that
 * is lost is re-minted and re-flashed, which is also how a doorbell that
 * walked off is revoked.
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
