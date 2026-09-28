import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { Device } from '../models/Device.js';
import { Membership } from '../models/Membership.js';
import { parseDeviceCredential, secretMatchesHash } from '../utils/deviceCredential.js';
import { ROLE_DEVICE, ROLE_PI, ROLE_BROWSER } from './registry.js';

/**
 * Turns a `hello` frame into "this socket may speak for that doorbell",
 * or refuses.
 *
 * Three roles, two completely different credentials. The daemon and the
 * media script both present the device credential; a browser presents a
 * user's JWT and has its membership checked here, at connect time. That
 * check is half of what makes "removing someone revokes their access
 * immediately" true - the other half is that media tokens are short
 * lived, so an already-open socket cannot outlive the access that
 * justified it by more than a token's lifetime.
 *
 * Returns { device } on success, or { error } for a refusal. Anything
 * transient throws instead, and the caller must not answer - see the
 * caller for why that distinction is load-bearing here specifically.
 *
 * A refusal may also carry { retryable: true }, which the caller turns
 * into close code 1013 rather than 4002. Nothing here sets it today and
 * that is not an oversight: every refusal below - an unparseable
 * credential, a wrong secret, a device that does not exist, an expired
 * JWT - is permanent for this connection attempt, and telling a doorbell
 * to keep retrying one of those would be a doorbell hammering a server
 * that will never say yes.
 *
 * It is here for the refusal that does not exist yet. "Pause this
 * doorbell" or "disable this device" is a policy answer, not an
 * authentication one, and sending it as 4002 would stop the hardware
 * until somebody restarted it on site - an unpausable pause. Anything of
 * that kind belongs here with retryable set, or does not belong here at
 * all: leave the socket up and stop acting on what it sends.
 */
export async function authenticate({ role, deviceId, token }) {
  if (![ROLE_DEVICE, ROLE_PI, ROLE_BROWSER].includes(role)) {
    return { error: `Unknown role "${role}"` };
  }
  if (typeof token !== 'string' || !token) return { error: 'A token is required' };

  return role === ROLE_BROWSER
    ? authenticateBrowser(deviceId, token)
    : authenticateHardware(deviceId, token);
}

/**
 * The daemon and the media script. Same credential, different roles -
 * which is the whole point of the role field, since one Pi runs both
 * processes and they must not displace each other.
 */
async function authenticateHardware(deviceId, token) {
  const parsed = parseDeviceCredential(token);
  // One message for malformed, unknown and wrong-secret alike. Anything
  // more specific is a way to probe which doorbells exist.
  if (!parsed) return { error: 'Invalid device credential' };

  const device = await Device.findOne({ deviceId: parsed.deviceId });
  if (!device) return { error: 'Invalid device credential' };
  if (!secretMatchesHash(parsed.secret, device.credentialHash)) {
    return { error: 'Invalid device credential' };
  }

  // The credential names a doorbell and so does the hello. They have to
  // agree, or porch-1 could speak for porch-2 just by saying so - the
  // credential check alone would pass, because porch-1's credential is
  // perfectly valid.
  if (deviceId && deviceId !== device.deviceId) {
    return { error: 'Credential does not match the requested device' };
  }

  return { device };
}

/**
 * A person watching. `deviceId` here is the Mongo id the app already
 * holds, not the hardware slug - the browser has never seen a slug, and
 * a doorbell with no hardware paired does not have one.
 */
async function authenticateBrowser(deviceId, token) {
  let userId;
  try {
    userId = jwt.verify(token, process.env.JWT_SECRET).sub;
  } catch (err) {
    // Expiry included: an expired token is a permanent answer for this
    // connection attempt. Reconnecting with a fresh one is the fix, and
    // that is the client's job.
    return { error: 'Invalid or expired token' };
  }

  if (!mongoose.isValidObjectId(deviceId)) return { error: 'Device not found' };

  // Same 404-shaped answer for "no such device" and "not yours", for the
  // same reason requireDeviceAccess gives one: distinguishing them lets
  // someone probe which device ids are real.
  const membership = await Membership.findOne({ device: deviceId, user: userId });
  if (!membership) return { error: 'Device not found' };

  const device = await Device.findById(deviceId);
  if (!device) return { error: 'Device not found' };

  return { device, userId };
}
