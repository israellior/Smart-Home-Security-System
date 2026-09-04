import mongoose from 'mongoose';

// A single motion or ring event. This is the collection the C
// motion-detection program (v4l2_motion_detect.c) would eventually
// POST to via /api/devices/:id/events once it's running on real
// hardware - see the backend README for the exact shape it should send.
const eventSchema = new mongoose.Schema(
  {
    device: { type: mongoose.Schema.Types.ObjectId, ref: 'Device', required: true, index: true },
    type: { type: String, enum: ['motion', 'ring'], required: true },
    // Optional free-form details - e.g. { pixelsChanged: 2240 } from the
    // motion detector's frame-diff output.
    meta: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  { timestamps: true }
);

eventSchema.index({ device: 1, createdAt: -1 });

export const Event = mongoose.model('Event', eventSchema);
