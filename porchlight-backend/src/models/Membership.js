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
    role: { type: String, enum: ['owner', 'member'], required: true, default: 'member' }
  },
  { timestamps: true }
);

// Load-bearing, not just tidiness: this is what makes joining a device
// idempotent. Submitting the same share code twice - a double-tapped
// button, a retried request - hits a duplicate key error instead of
// silently granting a second membership.
membershipSchema.index({ device: 1, user: 1 }, { unique: true });

membershipSchema.set('toJSON', {
  transform(doc, ret) {
    delete ret.__v;
    return ret;
  }
});

export const Membership = mongoose.model('Membership', membershipSchema);
