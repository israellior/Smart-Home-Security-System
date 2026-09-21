import mongoose from 'mongoose';
import { Device } from '../models/Device.js';
import { Membership } from '../models/Membership.js';
import { Event } from '../models/Event.js';
import { generateShareCode, normalizeShareCode } from '../utils/shareCode.js';

// Fields a client is allowed to set. Anything else in the body - owner,
// connected, _id - is ignored rather than rejected, so a client sending
// back a whole device document doesn't get an error, it just can't
// escalate anything. `connected` is absent on purpose: only real
// hardware reporting in should ever flip it.
const EDITABLE_FIELDS = ['name', 'location', 'sensitivity'];

// Per-person, per-device. Set on the caller's Membership, not the Device.
const NOTIFICATION_PREFS = ['notifMotion', 'notifRing', 'notifDaily'];

/**
 * Shapes a device for one particular member: the device's own fields,
 * plus that member's role and their personal notification preferences.
 *
 * Flattening the preferences onto the device keeps the response shape
 * the client already expects (device.notifMotion), even though they now
 * come from a different collection. Only the write path had to change.
 *
 * The share code is the credential that grants access to this doorbell,
 * so only the owner - the person entitled to hand out access - sees it.
 */
function deviceForMember(device, membership) {
  const json = device.toJSON();
  if (membership.role !== 'owner') delete json.shareCode;

  for (const key of NOTIFICATION_PREFS) json[key] = membership[key];
  json.role = membership.role;
  json.lastSeenAt = membership.lastSeenAt;

  // Derived rather than stored, because the stored form is a secret the
  // schema strips on the way out. "Is there hardware behind this?" is a
  // question the UI genuinely needs answered and cannot otherwise ask:
  // `provisioned` is not `connected`. Provisioned means a Pi was built
  // for this doorbell and holds a credential; connected means one is on
  // the other end of a socket right now. A doorbell can be provisioned
  // and unplugged.
  json.provisioned = Boolean(device.credentialHash);

  return json;
}

/**
 * How many events each device has seen since that membership last looked.
 *
 * Every device has its own watermark, so the naive shape is one count
 * query per device - an N+1 that grows with someone's device list. This
 * folds them into a single aggregation: one $or branch per device, each
 * an indexed range seek on { device, receivedAt }, grouped by device.
 *
 * Counted against `receivedAt`, not `at`. The activity list is ordered by
 * `at` - when the sensor fired - but "new since you last looked" has to
 * mean "arrived since you last looked", and those differ exactly when it
 * matters most: an alert queued through an outage carries an old `at`,
 * so counting by `at` would file yesterday's doorbell press below today's
 * watermark and mark it read before anyone saw it.
 */
async function newEventCountsByDevice(memberships) {
  const branches = memberships
    .filter((m) => m.device)
    .map((m) => ({
      device: m.device._id,
      // Never looked means everything counts as new.
      receivedAt: { $gt: m.lastSeenAt || new Date(0) }
    }));

  if (branches.length === 0) return new Map();

  const rows = await Event.aggregate([
    { $match: { $or: branches } },
    { $group: { _id: '$device', count: { $sum: 1 } } }
  ]);

  return new Map(rows.map((r) => [String(r._id), r.count]));
}

export async function listDevices(req, res) {
  const memberships = await Membership.find({ user: req.userId })
    .populate('device')
    .sort({ createdAt: 1 });

  const counts = await newEventCountsByDevice(memberships);

  const devices = memberships
    // A membership whose device was deleted shouldn't break the whole
    // list - skip it rather than throwing on a null populate.
    .filter((m) => m.device)
    .map((m) => ({
      ...deviceForMember(m.device, m),
      newEventCount: counts.get(String(m.device._id)) || 0
    }));

  return res.json({ devices });
}

/**
 * Moves the caller's watermark to now - "I've seen the activity list".
 * Writes only the caller's membership, so like preferences it needs no
 * permission check beyond already having access.
 */
export async function markDeviceSeen(req, res) {
  req.membership.lastSeenAt = new Date();
  await req.membership.save();
  return res.json({ lastSeenAt: req.membership.lastSeenAt });
}

export async function getDevice(req, res) {
  return res.json({ device: deviceForMember(req.device, req.membership) });
}

export async function createDevice(req, res) {
  const { name, location } = req.body;

  // Share codes are random, so a collision is possible even if unlikely.
  // The unique index is the real guarantee; this loop just turns a
  // one-in-a-million duplicate key into a retry instead of a 500.
  let device = null;
  for (let attempt = 0; attempt < 5 && !device; attempt++) {
    try {
      device = await Device.create({
        name: name?.trim() || 'Front Door',
        location: location?.trim() || '',
        shareCode: generateShareCode()
      });
    } catch (err) {
      if (err.code === 11000 && err.keyPattern?.shareCode) continue;
      throw err;
    }
  }

  if (!device) {
    return res.status(503).json({ error: 'Could not allocate a share code, please try again' });
  }

  const membership = await Membership.create({
    device: device._id,
    user: req.userId,
    role: 'owner'
  });
  return res.status(201).json({ device: deviceForMember(device, membership) });
}

/**
 * Join a doorbell with its share code, and claim it if nobody has.
 *
 * Hardware is provisioned with no owner - a doorbell boots and reports
 * before any account exists for it - so the first person to submit its
 * share code becomes the owner and everyone after is a member. That is
 * the whole claiming story: the device never takes part in it.
 *
 * Idempotent on purpose: a double-tapped button or a retried request
 * re-reports the membership the caller already has instead of erroring.
 */
export async function joinDevice(req, res) {
  const shareCode = normalizeShareCode(req.body?.shareCode);
  if (!shareCode) {
    return res.status(400).json({ error: 'A share code is required' });
  }

  const device = await Device.findOne({ shareCode });
  if (!device) {
    return res.status(404).json({ error: 'No doorbell found with that code' });
  }

  const existing = await Membership.findOne({ device: device._id, user: req.userId });
  if (existing) {
    return res.json({ device: deviceForMember(device, existing), alreadyMember: true });
  }

  const unclaimed = !(await Membership.exists({ device: device._id, role: 'owner' }));

  let membership;
  try {
    membership = await Membership.create({
      device: device._id,
      user: req.userId,
      role: unclaimed ? 'owner' : 'member'
    });
  } catch (err) {
    if (err.code !== 11000) throw err;

    // Two possible collisions, and they need different answers.
    //
    // On { device, user }: the same person joined twice at once. They are
    // a member either way, so read back the winner's membership - the
    // response has to carry their real preferences.
    const won = await Membership.findOne({ device: device._id, user: req.userId });
    if (won) {
      return res.json({ device: deviceForMember(device, won), alreadyMember: true });
    }

    // On { device, role: 'owner' }: two people claimed an unowned
    // doorbell in the same instant and this one lost. Losing the claim is
    // not losing access - retry as a member, which is what they would
    // have got a millisecond later anyway.
    membership = await Membership.create({
      device: device._id,
      user: req.userId,
      role: 'member'
    });
  }

  return res.status(201).json({ device: deviceForMember(device, membership) });
}

export async function updateDevice(req, res) {
  const { device } = req;

  for (const field of EDITABLE_FIELDS) {
    if (field in req.body) device[field] = req.body[field];
  }

  await device.save();
  return res.json({ device: deviceForMember(device, req.membership) });
}

/**
 * Updates the caller's own notification preferences for this device.
 * Separate from PATCH /devices/:id because it writes a different
 * document: your membership, not the shared device. Any member may call
 * it, and it can only ever affect the caller - there's no way to express
 * "change someone else's alerts", by construction rather than by check.
 */
export async function updatePreferences(req, res) {
  const { membership } = req;

  for (const key of NOTIFICATION_PREFS) {
    if (key in req.body) membership[key] = Boolean(req.body[key]);
  }

  await membership.save();
  return res.json({ device: deviceForMember(req.device, membership) });
}

export async function deleteDevice(req, res) {
  const deviceId = req.device._id;

  // Mongo has no cascading deletes, so orphaned events and memberships
  // are ours to clean up. Events first: if this dies halfway, a device
  // with no events is a better failure than events pointing at nothing.
  await Event.deleteMany({ device: deviceId });
  await Membership.deleteMany({ device: deviceId });
  await Device.deleteOne({ _id: deviceId });

  return res.status(204).end();
}

export async function listMembers(req, res) {
  const memberships = await Membership.find({ device: req.device._id })
    // Projected to just the two display fields. The schema-level toJSON
    // on User strips passwordHash regardless - this projection is the
    // first layer, that transform is the one that still holds if someone
    // later widens or drops it.
    .populate('user', 'name email')
    .sort({ createdAt: 1 });

  const members = memberships
    .filter((m) => m.user)
    .map((m) => ({
      userId: m.user._id,
      name: m.user.name,
      email: m.user.email,
      role: m.role,
      joinedAt: m.createdAt,
      isYou: String(m.user._id) === String(req.userId)
    }));

  return res.json({ members });
}

/**
 * Removing someone else requires ownership; removing yourself is
 * "leave this doorbell" and needs no special role. Both land here
 * because they're the same state change - one membership goes away.
 */
export async function removeMember(req, res) {
  const { userId } = req.params;
  if (!mongoose.isValidObjectId(userId)) {
    return res.status(404).json({ error: 'Member not found' });
  }

  const isSelf = String(userId) === String(req.userId);
  if (!isSelf && req.membership.role !== 'owner') {
    return res.status(403).json({ error: 'Only the doorbell owner can remove other people' });
  }

  const target = await Membership.findOne({ device: req.device._id, user: userId });
  if (!target) {
    return res.status(404).json({ error: 'Member not found' });
  }

  if (target.role === 'owner') {
    // Letting the owner walk away would strand the doorbell with nobody
    // able to manage or delete it. Transferring ownership is a separate
    // feature; until it exists, deleting is the way out.
    return res.status(409).json({
      error: isSelf
        ? 'The owner cannot leave a doorbell. Delete it instead.'
        : 'The owner cannot be removed'
    });
  }

  await Membership.deleteOne({ _id: target._id });
  return res.status(204).end();
}
