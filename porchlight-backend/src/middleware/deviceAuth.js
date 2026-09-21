import { Device } from '../models/Device.js';
import { parseDeviceCredential, secretMatchesHash } from '../utils/deviceCredential.js';

// A doorbell that is awake talks to us constantly - media tokens, clip
// uploads, socket reconnects. Writing lastContactAt on every one of those
// turns a read-only request into a write for no new information. A minute
// of resolution is far finer than any "is it online?" UI needs.
const CONTACT_THROTTLE_MS = 60 * 1000;

/**
 * The device-side counterpart to requireAuth. Reads
 * "Authorization: Bearer <device credential>", resolves the Pi it
 * belongs to, and attaches req.hardware.
 *
 * Named req.hardware rather than req.device on purpose: req.device is
 * already taken by requireDeviceAccess, where it means "a device this
 * *user* may touch". The two middlewares answer different questions and
 * must never be mistaken for each other - a handler that reads the wrong
 * one would be authorizing against the wrong principal entirely.
 *
 * Nothing here catches database errors. That is deliberate: a Mongo blip
 * must surface as a 500, never as a 401. The distinction matters more
 * than it looks - on the signaling socket the same logic decides between
 * `ok: false`, which makes the device drop an alert *permanently*, and
 * silence, which makes it retry. Authentication failures are permanent
 * answers, so only genuine authentication failures may produce them.
 */
export async function requireDevice(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, raw] = header.split(' ');

  if (scheme !== 'Bearer' || !raw) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }

  const parsed = parseDeviceCredential(raw);
  // One message for malformed, unknown and wrong-secret alike. Telling a
  // caller that porch-1 exists but the secret is wrong is a probe for
  // which doorbells are real.
  const reject = () => res.status(401).json({ error: 'Invalid device credential' });

  if (!parsed) return reject();

  const device = await Device.findOne({ deviceId: parsed.deviceId });
  if (!device) return reject();
  if (!secretMatchesHash(parsed.secret, device.credentialHash)) return reject();

  // Every device-authenticated route is mounted under /:deviceId, so the
  // path and the credential both name a device. They have to agree, or
  // porch-1 could mint a media token for porch-2 simply by asking for it
  // - the credential check alone would pass, because porch-1's
  // credential is perfectly valid.
  if (req.params.deviceId && req.params.deviceId !== device.deviceId) {
    return res.status(403).json({ error: 'Credential does not match the device in the path' });
  }

  req.hardware = device;
  await recordContact(device);
  next();
}

/**
 * Best-effort liveness telemetry. Wrapped rather than awaited bare
 * because failing to note that a doorbell said hello is not a reason to
 * fail the thing it was actually asking for.
 */
async function recordContact(device) {
  const now = Date.now();
  if (device.lastContactAt && now - device.lastContactAt.getTime() < CONTACT_THROTTLE_MS) return;

  try {
    device.lastContactAt = new Date(now);
    await device.save();
  } catch (err) {
    console.error(`Could not record contact for ${device.deviceId}:`, err.message);
  }
}
