import mongoose from 'mongoose';
import { Membership } from '../models/Membership.js';
import { Device } from '../models/Device.js';

// Device routes are mounted under two different param names (:id for the
// device itself, :deviceId for its nested events), so resolve either.
function deviceIdFrom(req) {
  return req.params.deviceId || req.params.id;
}

/**
 * Gate for every route that touches one specific device. Confirms the
 * caller has a Membership for it, then hands the controller a loaded
 * req.device and req.membership so it never re-queries or re-checks.
 *
 * Access control used to be a convention - each controller remembering
 * to call assertOwnsDevice - which fails open: write one handler that
 * forgets, and it reads another household's doorbell. As middleware it
 * fails closed, because a route without it simply has no req.device.
 *
 * The isValidObjectId guard is not cosmetic. Passing a non-ObjectId
 * string (say /api/devices/banana/events) straight into a Mongo query
 * throws CastError, which surfaced to clients as a 500 "Something went
 * wrong on the server" - telling them the server is broken when they
 * had actually asked for something that cannot exist.
 */
export async function requireDeviceAccess(req, res, next) {
  const id = deviceIdFrom(req);

  // Same 404 for malformed, nonexistent, and not-yours. Distinguishing
  // them would let someone probe which device ids are real.
  const notFound = () => res.status(404).json({ error: 'Device not found' });

  if (!mongoose.isValidObjectId(id)) return notFound();

  const membership = await Membership.findOne({ device: id, user: req.userId });
  if (!membership) return notFound();

  const device = await Device.findById(id);
  if (!device) return notFound();

  req.membership = membership;
  req.device = device;
  next();
}

/**
 * Stacks after requireDeviceAccess for owner-only actions.
 *
 * 403 rather than 404 here, deliberately: the caller demonstrably has
 * access to this device - it's in their list - so pretending it doesn't
 * exist would be confusing rather than protective. There's nothing left
 * to hide, only a permission to deny.
 */
export function requireDeviceOwner(req, res, next) {
  if (req.membership?.role !== 'owner') {
    return res.status(403).json({ error: 'Only the doorbell owner can do that' });
  }
  next();
}
