import { randomInt } from 'node:crypto';

// No 0/O, 1/I/L - these codes get read aloud ("my code is PORCH-7K2M9P")
// or copied off a screen, and those pairs are where transcription fails.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const PREFIX = 'PORCH';

/**
 * A device's share code - the thing one user reads out so another can
 * join. randomInt (not Math.random) because this is the only credential
 * standing between a stranger and someone's doorbell: Math.random is
 * seeded predictably and is not meant for anything security-adjacent.
 *
 * 31^6 is ~887 million combinations, which is plenty of headroom for a
 * household app. Uniqueness is still enforced by a unique index on the
 * Device collection - this function only makes collisions rare, the
 * index makes them impossible.
 */
export function generateShareCode() {
  let body = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    body += ALPHABET[randomInt(ALPHABET.length)];
  }
  return `${PREFIX}-${body}`;
}

/**
 * Accepts what a human actually types - "porch-7k2m9p", "7K2M9P",
 * " PORCH 7K2M9P " - and returns the canonical form, or '' if there's
 * nothing usable. Normalizing on the way in means the stored code has
 * exactly one representation and lookups are a plain equality match.
 */
export function normalizeShareCode(input) {
  const cleaned = String(input ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

  const body = cleaned.startsWith(PREFIX) ? cleaned.slice(PREFIX.length) : cleaned;
  return body ? `${PREFIX}-${body}` : '';
}
