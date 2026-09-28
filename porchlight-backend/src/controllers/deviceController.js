import mongoose from 'mongoose';
import { Device } from '../models/Device.js';
import { Membership } from '../models/Membership.js';
import { Event } from '../models/Event.js';
import { Clip } from '../models/Clip.js';
import { storageConfigured, deleteClipObjects } from '../config/storage.js';
import { generateShareCode, normalizeShareCode } from '../utils/shareCode.js';
import {
  claimCodeConfigured,
  hashClaimCode,
  isValidClaimCode,
  normalizeClaimCode
} from '../utils/claimCode.js';
import { consume, forget } from '../utils/rateLimit.js';
import { disconnectHardware } from '../signaling/index.js';

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

/**
 * A doorbell that exists in the app before any hardware does.
 *
 * No share code. One is generated on demand by createShareCode below,
 * when the owner actually wants to let somebody else in - which is the
 * A6 change, and the reason the collision-retry loop that used to be here
 * is gone with it: nothing is allocated at creation to collide.
 */
export async function createDevice(req, res) {
  const { name, location } = req.body;

  const device = await Device.create({
    name: name?.trim() || 'Front Door',
    location: location?.trim() || ''
  });

  const membership = await Membership.create({
    device: device._id,
    user: req.userId,
    role: 'owner'
  });
  return res.status(201).json({ device: deviceForMember(device, membership) });
}

/**
 * Join a doorbell somebody else owns, with the share code they gave you.
 *
 * A share code makes you a member. It no longer makes anybody an owner,
 * and that is the A6 change here.
 *
 * It used to: hardware was minted with a share code printed beside its
 * credential, and the first person to type that code became the owner. On
 * a doorbell bolted to the outside of a house, with the code on a sticker
 * on the back of the case, that meant anyone who photographed the unit or
 * found the packaging could take ownership of a camera pointed at a front
 * door - permanently, with no interaction with the person who bought it.
 *
 * Ownership now comes from a claim code, which is single-use and consumed.
 * Share codes are generated inside the app by someone who already owns
 * the doorbell, are revocable, and are printed on nothing.
 *
 * Idempotent on purpose: a double-tapped button or a retried request
 * re-reports the membership the caller already has instead of erroring.
 */
export async function joinDevice(req, res) {
  const raw = String(req.body?.shareCode ?? '');
  const shareCode = normalizeShareCode(raw);
  if (!shareCode) {
    return res.status(400).json({ error: 'A share code is required' });
  }

  const device = await Device.findOne({ shareCode });
  if (!device) {
    // The two codes look different on purpose - a share code carries the
    // PORCH- prefix and a claim code is six bare characters - so when
    // someone types the code off the back of a new doorbell into the
    // wrong box, say which box it belongs in rather than telling them
    // their doorbell does not exist.
    if (isValidClaimCode(raw)) {
      return res.status(404).json({
        error:
          'That looks like the claim code on a new doorbell. Use "Set up a new doorbell" instead.'
      });
    }
    return res.status(404).json({ error: 'No doorbell found with that code' });
  }

  const existing = await Membership.findOne({ device: device._id, user: req.userId });
  if (existing) {
    return res.json({ device: deviceForMember(device, existing), alreadyMember: true });
  }

  // A share code on a doorbell nobody owns is a leftover from when mint
  // printed one, and honouring it would be the old hole still open. There
  // is nobody to be a member *of*, so send them to the claim flow.
  const owned = await Membership.exists({ device: device._id, role: 'owner' });
  if (!owned) {
    return res.status(409).json({
      error: 'Nobody has set this doorbell up yet. Claim it with the code on the unit itself.'
    });
  }

  let membership;
  try {
    membership = await Membership.create({
      device: device._id,
      user: req.userId,
      role: 'member'
    });
  } catch (err) {
    if (err.code !== 11000) throw err;

    // The same person joined twice at once, colliding on { device, user }.
    // They are a member either way, so read back the winner's membership
    // - the response has to carry their real preferences.
    const won = await Membership.findOne({ device: device._id, user: req.userId });
    if (won) {
      return res.json({ device: deviceForMember(device, won), alreadyMember: true });
    }
    throw err;
  }

  return res.status(201).json({ device: deviceForMember(device, membership) });
}

// How hard somebody may guess. A claim code is six characters from a
// 31-character alphabet - 887 million values, which is far too many to
// type and not many at all to script.
//
// Only *failures* are charged (see forget() on the way out), so a
// customer who fumbles their own code twice and then gets it right pays
// nothing. Per account is the control that matters, because every claim
// is made by a signed-in user and is therefore attributable; per code is
// what stops one known code being hammered from a pool of accounts.
const CLAIM_LIMIT_PER_ACCOUNT = { limit: 10, windowMs: 10 * 60 * 1000 };
const CLAIM_LIMIT_PER_CODE = { limit: 5, windowMs: 60 * 60 * 1000 };

/**
 * Claim a doorbell with the one-time code on the unit - the only way to
 * become an owner of hardware.
 *
 * Consumed by the first success, and the consequence is worth stating
 * rather than discovering: a doorbell that changes hands needs the seller
 * to release it, or support to re-mint the code. A permanent code has no
 * such friction, which is exactly why it is unsafe. Releasing a device is
 * an app feature; a stranger watching a door is not a feature.
 */
export async function claimDevice(req, res) {
  // Mirrors mediaConfigured / storageConfigured: a missing key is a
  // deployment fact, answered as one. Failing closed matters here - the
  // alternative fallback would be an unkeyed hash, which is a weaker
  // secret silently substituted for a stronger one.
  if (!claimCodeConfigured) {
    return res.status(503).json({ error: 'Claiming is not configured on this server' });
  }

  const claimCode = normalizeClaimCode(req.body?.claimCode);
  if (!isValidClaimCode(claimCode)) {
    // The format is public - it is printed on the box - so saying it is
    // malformed reveals nothing, and it saves a rate-limit slot for a
    // guess that could never have worked.
    return res.status(400).json({ error: 'A claim code is six letters and numbers' });
  }

  // Hashed before it is used as a bucket key as well as a lookup key, so
  // a process dump does not hold a list of recently guessed plaintext
  // codes.
  const claimCodeHash = hashClaimCode(claimCode);

  const perAccount = consume('claim:account', String(req.userId), CLAIM_LIMIT_PER_ACCOUNT);
  const perCode = consume('claim:code', claimCodeHash, CLAIM_LIMIT_PER_CODE);
  if (!perAccount.allowed || !perCode.allowed) {
    const retryAfterMs = Math.max(perAccount.retryAfterMs, perCode.retryAfterMs);
    res.set('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
    return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  }

  const device = await Device.findOne({ claimCodeHash });
  if (!device) {
    return res.status(404).json({ error: 'No doorbell found with that code' });
  }

  // Already spent. The hash is deliberately *not* cleared when a code is
  // consumed, and this is why: clearing it would make the second person
  // holding the same photograph get "no doorbell found with that code",
  // which is misleading in exactly the situation where the truth is worth
  // telling. The hash is keyed, so keeping it costs nothing.
  if (device.claimedAt) {
    return res.status(409).json({
      error:
        'That code has already been used. Ask whoever set the doorbell up to share it with you.'
    });
  }

  const existing = await Membership.findOne({ device: device._id, user: req.userId });
  if (existing) {
    forget('claim:account', String(req.userId));
    return res.json({ device: deviceForMember(device, existing), alreadyMember: true });
  }

  // Belt and braces beside claimedAt. The two can only disagree if a
  // claim was rolled back after its membership landed, or if an operator
  // cleared claimedAt by hand - but the unique owner index would turn
  // that into a duplicate-key 500, and "already set up" is the true
  // answer rather than "something went wrong on the server".
  if (await Membership.exists({ device: device._id, role: 'owner' })) {
    return res.status(409).json({
      error: 'That doorbell is already set up. Ask its owner to share it with you.'
    });
  }

  /**
   * Spend the code first, then take ownership - and the order is the
   * whole of the concurrency story.
   *
   * This is a conditional update, so two people submitting the same code
   * in the same instant cannot both pass it: one gets the document back,
   * the other gets null and a 409. Doing it the other way round - create
   * the membership, then spend the code - would leave a window where the
   * doorbell has an owner and a live claim code, and the loser of that
   * race would collide on the owner index and fall through to becoming a
   * *member*. A stranger with a photograph would get ongoing access as a
   * consolation prize.
   */
  const claimed = await Device.findOneAndUpdate(
    { _id: device._id, claimedAt: null },
    { $set: { claimedAt: new Date() } },
    { new: true }
  );
  if (!claimed) {
    return res.status(409).json({ error: 'That code has already been used' });
  }

  let membership;
  try {
    membership = await Membership.create({
      device: claimed._id,
      user: req.userId,
      role: 'owner'
    });
  } catch (err) {
    // The code is spent and nobody owns the doorbell, which is a state
    // only support can get out of. So put it back. Re-running the claim
    // is then just a retry.
    await Device.updateOne({ _id: claimed._id }, { $set: { claimedAt: null } }).catch(() => {});
    throw err;
  }

  forget('claim:account', String(req.userId));
  forget('claim:code', claimCodeHash);

  return res.status(201).json({ device: deviceForMember(claimed, membership) });
}

/**
 * Mint or rotate this doorbell's share code. Owner only.
 *
 * On demand rather than at birth, because a code that exists is a code
 * that can leak, and most doorbells are never shared with anyone. Calling
 * this again rotates: whoever held the old one can no longer join, which
 * together with removeMember is how an owner takes access back from
 * somebody who has already used it.
 */
export async function createShareCode(req, res) {
  const { device } = req;

  // Random, so a collision is possible even if vanishingly unlikely. The
  // unique index is the real guarantee; this loop turns a
  // one-in-a-million duplicate key into a retry instead of a 500.
  for (let attempt = 0; attempt < 5; attempt++) {
    device.shareCode = generateShareCode();
    try {
      await device.save();
      return res.json({ device: deviceForMember(device, req.membership) });
    } catch (err) {
      if (err.code === 11000 && err.keyPattern?.shareCode) continue;
      throw err;
    }
  }

  return res.status(503).json({ error: 'Could not allocate a share code, please try again' });
}

/**
 * Revoke it. Owner only.
 *
 * $unset rather than a sentinel value, so the partial unique index stops
 * indexing this document entirely - every doorbell with no share code
 * would otherwise collide with every other on whatever the sentinel was.
 *
 * Note what this does and does not do: it stops *new* people joining. It
 * does not remove anybody who already joined, because a code and a
 * membership are different things - use removeMember for that.
 */
export async function revokeShareCode(req, res) {
  const { device } = req;

  await Device.updateOne({ _id: device._id }, { $unset: { shareCode: 1 } });
  // Mirrored onto the loaded document so the response is the device as it
  // now is, rather than as it was a line ago.
  device.shareCode = undefined;

  return res.json({ device: deviceForMember(device, req.membership) });
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

  // Recordings first, and the bucket before the rows that point at it.
  // A deleted doorbell leaving its video behind is the one failure here
  // with a privacy cost - the other orphans are only clutter - and once
  // the Clip rows are gone there is nothing left that knows the objects
  // exist. Best-effort: a bucket that is unreachable must not block
  // someone deleting their doorbell.
  if (storageConfigured && req.device.deviceId) {
    const clips = await Clip.find({ device: deviceId }, { eventId: 1 });
    if (clips.length > 0) {
      try {
        await deleteClipObjects(req.device.deviceId, clips.map((c) => c.eventId));
      } catch (err) {
        console.error(`Could not remove clips for ${req.device.deviceId}:`, err.message);
      }
    }
  }
  await Clip.deleteMany({ device: deviceId });

  // Mongo has no cascading deletes, so orphaned events and memberships
  // are ours to clean up. Events first: if this dies halfway, a device
  // with no events is a better failure than events pointing at nothing.
  await Event.deleteMany({ device: deviceId });
  await Membership.deleteMany({ device: deviceId });
  await Device.deleteOne({ _id: deviceId });

  // Tell the hardware, and only now that the record is actually gone -
  // closing first would leave a window in which the doorbell reconnects
  // and re-registers against a device we are halfway through deleting.
  //
  // This is the one refusal in the system that is genuinely permanent, so
  // it is the one place the device is closed with 4002 unprompted: the
  // credential will never authenticate again, and a doorbell that is
  // never told keeps a socket open to a server that 401s its every call.
  // No fault LED, no reconnect, nothing at the house to suggest anything
  // is wrong. Which is also why deleting deserves a confirmation that
  // says what it does to the unit on the wall.
  disconnectHardware(String(deviceId), 'This doorbell was deleted');

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
