import { createHmac, randomInt } from 'node:crypto';

/**
 * Claim codes - the code on the sticker that makes a doorbell someone's.
 *
 * This is NOT the share code, and the difference is the whole reason the
 * file exists. See utils/shareCode.js for the other half.
 *
 *   claim code   the first owner, once      consumed by the first claim
 *   share code   a flatmate, a neighbour    generated in the app, revocable
 *
 * A share code is permanent, and a doorbell is bolted to the outside of a
 * house. If the code printed on the case were the share code, then
 * anyone who photographs the back of the unit - a delivery driver, a
 * guest, someone who finds the packaging in a recycling bin - could join
 * that doorbell to their own account and watch the door forever, with no
 * interaction with the owner at all. So the code that ships on hardware
 * is single-use and the code that grants ongoing access is never printed
 * on anything.
 *
 * The trade is real and worth naming rather than discovering: a doorbell
 * that changes hands needs the seller to release it, or support to
 * re-mint the code. A permanent code has no such friction, which is
 * exactly why it is unsafe.
 */

// Same alphabet as the share code, and for the same reason: no 0/O and
// no 1/I/L, because this code is read off a sticker in poor light and
// typed into a phone. Six characters, no prefix - the prefix is what
// distinguishes a share code on sight, and telling the two apart is
// useful when somebody types the wrong one.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

/**
 * WHY HMAC AND NOT A BARE SHA-256.
 *
 * The device credential is hashed with a plain SHA-256 and that is
 * correct: it is 32 bytes from the OS CSPRNG, so there is nothing to
 * guess and no amount of stretching improves on 256 bits.
 *
 * This code is six characters from a 31-character alphabet. That is
 * about thirty bits - roughly 887 million values - and the entire
 * keyspace can be hashed in under a minute on commodity hardware. A bare
 * digest column would therefore give a stolen database dump essentially
 * no resistance at all, which is the one thing hashing was supposed to
 * buy. The code grants ownership of a camera pointed at a front door, so
 * that matters more here than anywhere else in the app.
 *
 * A per-row salt with bcrypt would fix the dump but breaks the lookup:
 * with no deterministic hash to index, every claim attempt becomes a
 * scan over every unclaimed device, each row costing a deliberate 100ms.
 * That is both slower and a denial-of-service lever.
 *
 * A keyed hash gets both. The digest stays deterministic, so a claim is
 * one indexed lookup whatever the size of the fleet, and the key is not
 * in the database - so a dump alone cannot be cracked at any speed.
 */
const PEPPER = process.env.CLAIM_CODE_PEPPER || '';

// Refuses a short key rather than accepting a weak one quietly. 16 bytes
// is the floor where the keyed hash is actually doing its job.
export const claimCodeConfigured = PEPPER.length >= 16;

/**
 * Deliberately not a silent fallback to JWT_SECRET or to an unkeyed
 * digest. A fallback would mean the codes minted on a box with the
 * variable missing hash differently from the ones minted with it - so
 * stickers would stop working depending on which machine ran the mint,
 * and nothing would say why. Loud and absent beats quiet and wrong.
 *
 * Rotating CLAIM_CODE_PEPPER invalidates every unclaimed sticker in
 * existence. It is not a routine rotation, and unlike JWT_SECRET it has
 * no reason to be one - nothing here expires.
 */
export function hashClaimCode(code) {
  if (!claimCodeConfigured) {
    throw new Error('CLAIM_CODE_PEPPER is not set (needs 16+ characters)');
  }
  return createHmac('sha256', PEPPER).update(normalizeClaimCode(code), 'utf8').digest('hex');
}

/**
 * randomInt, not Math.random: this is the only thing standing between a
 * stranger and someone's doorbell, and Math.random is seeded predictably.
 */
export function generateClaimCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

/**
 * Accepts what somebody actually types - "7k2m9p", " 7K2 M9P ". Lowercase
 * is normalized up rather than rejected, because the sticker is upper
 * case and a phone keyboard often is not.
 *
 * Hyphens and spaces are stripped, which also means a customer who types
 * their *share* code here ("PORCH-7K2M9P") normalizes to something twelve
 * characters long that cannot match any claim code. That is the right
 * outcome: it fails, rather than half-matching.
 */
export function normalizeClaimCode(input) {
  return String(input ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

export function isValidClaimCode(input) {
  const code = normalizeClaimCode(input);
  return code.length === CODE_LENGTH && [...code].every((c) => ALPHABET.includes(c));
}
