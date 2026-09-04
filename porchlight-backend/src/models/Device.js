import mongoose from 'mongoose';

// One document per physical doorbell. Modeled as its own collection
// (rather than fields on User) so a single account could eventually
// manage more than one doorbell - the frontend just uses the first one
// for now.
const deviceSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
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
    connected: { type: Boolean, default: false }
  },
  { timestamps: true }
);

export const Device = mongoose.model('Device', deviceSchema);
