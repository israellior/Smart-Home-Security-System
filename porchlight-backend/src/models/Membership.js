import mongoose from 'mongoose';

/**
 * The join between a User and a Device - "this person has access to that
 * doorbell, in this role". Modeled as its own collection rather than an
 * array on Device so that "who can see this device" and "which devices
 * can I see" are both plain indexed queries, and so a future invite or
 * audit trail has somewhere to live.
 *
 * Roles:
 *   owner  - created the device. Can rename, delete, and manage access.
 *   member - joined with a share code. Can view and change settings,
 *            but cannot remove other people or delete the device.
 */
const membershipSchema = new mongoose.Schema(
  {
    device: { type: mongoose.Schema.Types.ObjectId, ref: 'Device', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    role: { type: String, enum: ['owner', 'member'], required: true, default: 'member' },

    // Notification preferences live here rather than on the Device,
    // because "do I want to hear about this" is a fact about a person's
    // relationship to a doorbell, not about the doorbell. While these
    // sat on Device, one housemate muting motion alerts muted them for
    // everyone sharing that device.
    notifMotion: { type: Boolean, default: true },
    notifRing: { type: Boolean, default: true },
    notifDaily: { type: Boolean, default: false },

    // Watermark for "new since you last looked". Everyone with access
    // sees every event, so there is no per-user read flag on events -
    // that would cost one row per member per event to store what this
    // single timestamp says. Null means never opened, so everything is
    // new. Unread count is then a range scan on { device, createdAt },
    // an index Event already has.
    lastSeenAt: { type: Date, default: null }
  },
  { timestamps: true }
);

// Load-bearing, not just tidiness: this is what makes joining a device
// idempotent. Submitting the same share code twice - a double-tapped
// button, a retried request - hits a duplicate key error instead of
// silently granting a second membership.
membershipSchema.index({ device: 1, user: 1 }, { unique: true });

// Notification dispatch queries { device, <pref>: true }. That is served
// by the { device, user } index above on its leading field, and the
// number of members per doorbell is small, so the scan after the seek is
// a handful of documents. Deliberately NOT adding one index per
// preference: three more indexes would slow every membership write to
// save nothing measurable. Over-indexing is a scaling problem, not a
// scaling fix.

membershipSchema.set('toJSON', {
  transform(doc, ret) {
    delete ret.__v;
    return ret;
  }
});

export const Membership = mongoose.model('Membership', membershipSchema);
