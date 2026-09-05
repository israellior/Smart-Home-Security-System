import mongoose from 'mongoose';

// One document per physical doorbell. Who can see it is no longer a
// field here - it lives in the Membership collection, so a device can be
// shared with more than one account (a household) and a single account
// can hold more than one doorbell.
const deviceSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, default: 'Front Door' },
    location: { type: String, trim: true, default: '' },
    sensitivity: {
      type: String,
      enum: ['low', 'standard', 'high'],
      default: 'standard'
    },
    notifMotion: { type: Boolean, default: true },
    notifRing: { type: Boolean, default: true },
    notifDaily: { type: Boolean, default: false },
    // True once real hardware has connected and reported in at least
    // once. Nothing sets this yet - it's here so the frontend's
    // "Connected" / "Not connected" status has a real field to read
    // instead of being hardcoded.
    connected: { type: Boolean, default: false },
    // The code another user types to join this device. Unique index is
    // what actually guarantees no two devices share one; see
    // utils/shareCode.js for why the alphabet excludes 0/O and 1/I/L.
    shareCode: { type: String, required: true, unique: true, index: true }
  },
  { timestamps: true }
);

// Applies to every serialization path - res.json(), a populated
// sub-document, an array - rather than relying on each controller to
// remember. _id is kept deliberately: the frontend uses device._id.
deviceSchema.set('toJSON', {
  transform(doc, ret) {
    delete ret.__v;
    return ret;
  }
});

export const Device = mongoose.model('Device', deviceSchema);
