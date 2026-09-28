import { randomInt } from 'node:crypto';

/**
 * The network a doorbell offers before it has one of its own.
 *
 * A unit out of the box is on no wi-fi, so `porchlight-setup.py` becomes
 * an access point, serves a page, and takes an SSID and a password from
 * whoever is standing there with a phone. Both halves of that AP's
 * identity are minted here and travel to the device in its birth
 * certificate, so the device chooses nothing and the sticker on the case
 * can be printed before the unit is ever powered on.
 */

// Same transcription-safe alphabet as the two codes: this password is
// read off a sticker and typed into a phone's wi-fi dialog, which is the
// least forgiving place in the whole setup flow to confuse O with 0.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

// WPA2 will not accept a passphrase shorter than eight characters, and
// the AP must have one at all. An open network with no route to the
// internet makes iOS decide it is broken and bounce the phone back to
// cellular within seconds - the customer never sees the page, and the
// symptom is "setup doesn't work on iPhone" with nothing in any log.
const PASSWORD_LENGTH = 12;

// Four characters is enough to tell two doorbells apart in a wi-fi list
// without making the name unreadable.
const SSID_SUFFIX_LENGTH = 4;

function pick(n) {
  let out = '';
  for (let i = 0; i < n; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/**
 * THE SSID SUFFIX IS NOT DERIVED FROM THE CLAIM CODE.
 *
 * It is tempting - `Porchlight-7K2M` out of claim code `7K2M9P` reads
 * nicely and needs no second random draw. It is also the one mistake in
 * this flow that gives a doorbell away.
 *
 * An SSID is broadcast in the clear to everyone in radio range, and the
 * AP is up during exactly the window in which the claim code is live and
 * unused. Deriving the name from the code would publish four of its six
 * characters to the street, leaving 31^2 = 961 guesses - a few seconds of
 * work - and a stranger could claim the doorbell before the person who
 * bought it finished reading the instructions.
 *
 * Drawn independently, the SSID says only "an unconfigured Porchlight is
 * nearby", which is already obvious to anyone who can see the box.
 *
 * The setup password is per-device for the neighbouring reason: one
 * shared password across a product line is one disclosure away from
 * anybody in range being able to hand any unconfigured doorbell a network
 * to join. The window is short, but it is a window.
 */
export function generateSetupAp() {
  return {
    setupSsid: `Porchlight-${pick(SSID_SUFFIX_LENGTH)}`,
    setupPassword: pick(PASSWORD_LENGTH)
  };
}
