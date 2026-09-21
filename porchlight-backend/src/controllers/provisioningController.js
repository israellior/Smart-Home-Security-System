import { Device } from '../models/Device.js';
import {
  generateDeviceCredential,
  generatePairingCode,
  hashPairingCode,
  isValidDeviceId,
  normalizeDeviceId,
  normalizePairingCode
} from '../utils/deviceCredential.js';

/**
 * Binding a real Raspberry Pi to a doorbell that already exists in the app.
 *
 * Three steps, three different principals, which is the whole point:
 *
 *   1. the owner asks the app for a pairing code      (user JWT, owner only)
 *   2. the Pi redeems that code for a credential      (the code *is* the auth)
 *   3. the Pi uses the credential from then on        (device credential)
 *
 * Step 2 is the only unauthenticated endpoint in the system, and it is
 * unauthenticated because it has to be: a factory-fresh Pi holds nothing.
 * What stands in for auth there is the code itself - single use, ten
 * minute expiry, and ~850 billion possibilities.
 */

/**
 * Step 1. Mints a pairing code for a device the caller owns.
 *
 * The plaintext is returned here and nowhere else, ever. Only its hash is
 * stored, so a later GET on this device cannot reveal it and neither can
 * a database dump. Calling this again replaces the outstanding code
 * rather than issuing a second - two live codes for one doorbell is two
 * chances for the wrong Pi to claim it.
 */
export async function createPairingCode(req, res) {
  const { code, codeHash, expiresAt } = generatePairingCode();

  req.device.pairingCodeHash = codeHash;
  req.device.pairingExpiresAt = expiresAt;
  await req.device.save();

  return res.status(201).json({
    pairingCode: code,
    expiresAt,
    // Said out loud in the response because the UI has to say it out
    // loud too. A code the user assumes they can come back for is a
    // support ticket.
    shownOnce: true
  });
}

/**
 * Step 2. The Pi presents the code and its own name, and gets a
 * credential back.
 *
 * Note what this does *not* require: no user token, no device id known
 * to us in advance, no pre-registration. The Pi chooses its own
 * `deviceId` and we record it - which is safe because the code proves
 * someone with access to the app also has hands on this hardware.
 */
export async function provisionDevice(req, res) {
  const code = normalizePairingCode(req.body?.pairingCode);
  const deviceId = normalizeDeviceId(req.body?.deviceId);

  if (!code) {
    return res.status(400).json({ error: 'A pairing code is required' });
  }
  if (!isValidDeviceId(deviceId)) {
    return res.status(400).json({
      error: 'deviceId must be 2-32 characters of lowercase letters, digits and hyphens'
    });
  }

  // Expiry is part of the query rather than a check afterwards, so an
  // expired code is indistinguishable from a wrong one - both are simply
  // "no such code". Checking it after the fact would confirm that a code
  // had once been real.
  const device = await Device.findOne({
    pairingCodeHash: hashPairingCode(code),
    pairingExpiresAt: { $gt: new Date() }
  });

  if (!device) {
    return res.status(404).json({ error: 'That pairing code is not valid or has expired' });
  }

  const { credential, credentialHash } = generateDeviceCredential(deviceId);

  // Re-pairing is the *only* recovery path for a lost credential, so it
  // has to work: this overwrites whatever was there. The previous
  // credential stops working the instant this saves, which is also what
  // makes re-pairing the way to revoke a Pi that walked off.
  device.deviceId = deviceId;
  device.credentialHash = credentialHash;
  device.pairedAt = new Date();

  // Single use. Cleared in the same save that writes the credential, so
  // there is no window where a redeemed code is still redeemable.
  device.pairingCodeHash = null;
  device.pairingExpiresAt = null;

  try {
    await device.save();
  } catch (err) {
    // Some other doorbell already answers to this name. 409 rather than
    // a generic 500: the caller can fix this by picking another, and
    // there is nothing to hide - they already hold a valid pairing code
    // for this device.
    if (err.code === 11000 && err.keyPattern?.deviceId) {
      return res.status(409).json({
        error: `Another doorbell is already provisioned as "${deviceId}"`
      });
    }
    throw err;
  }

  return res.status(201).json({
    credential,
    deviceId: device.deviceId,
    name: device.name,
    pairedAt: device.pairedAt,
    shownOnce: true
  });
}

/**
 * Step 3, and the smoke test for everything above: the first thing a
 * newly provisioned Pi can call to confirm its credential works.
 *
 * Returns the device as the *hardware* sees it - its own identity and the
 * settings that change how it behaves. Deliberately not the share code,
 * the member list, or anything else about the people involved: a doorbell
 * on someone's porch is the least physically secure thing in this system,
 * and it has no reason to know who lives there.
 */
export async function getHardwareSelf(req, res) {
  const { hardware } = req;

  return res.json({
    device: {
      deviceId: hardware.deviceId,
      name: hardware.name,
      location: hardware.location,
      sensitivity: hardware.sensitivity,
      pairedAt: hardware.pairedAt,
      lastContactAt: hardware.lastContactAt
    }
  });
}
