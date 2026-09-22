import mongoose from 'mongoose';

/**
 * One recording, and the record of where it is in a three-step upload.
 *
 * A collection of its own rather than a field on Event, because of one
 * detail of the device contract: step 1 - "give me somewhere to put
 * this" - carries an **empty body**. No kind, no timestamp, nothing but
 * the credential and the eventId in the path. There is not enough there
 * to create an Event, which requires a kind and a sensor time, so the
 * binding has to live somewhere that needs neither.
 *
 * That also makes rule 4 fall out for free: a clip may arrive before its
 * alert, or with no alert ever, and nothing here depends on the Event
 * existing. The confirm creates it.
 */
const clipSchema = new mongoose.Schema(
  {
    device: { type: mongoose.Schema.Types.ObjectId, ref: 'Device', required: true, index: true },

    // The device's own id for the event this clip belongs to. Paired
    // with `device` rather than standing alone: eventIds are unique per
    // doorbell, not globally, and the credential already says which
    // doorbell is calling.
    eventId: { type: String, required: true },

    // pending - a grant was issued; the object may or may not have
    //           been uploaded yet, and nothing should be shown.
    // stored  - confirmed, verified against the object, playable.
    status: { type: String, enum: ['pending', 'stored'], default: 'pending' },

    // All null until the confirm carries them. `bytes` is checked
    // against the stored object rather than trusted: a truncated upload
    // that still returns 2xx from the bucket is otherwise
    // indistinguishable from a good one.
    bytes: { type: Number, default: null },
    durationMs: { type: Number, default: null },

    // A viewer arrived and cut the recording short. The clip is playable
    // either way, but it is not the length that was asked for and the UI
    // should say so.
    partial: { type: Boolean, default: false },

    confirmedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

// One clip per event per doorbell, enforced rather than checked - step 1
// is idempotent and a device retrying it must not end up with two
// bindings racing for one object.
clipSchema.index({ device: 1, eventId: 1 }, { unique: true });

// Object keys are derived from (deviceId, eventId) in config/storage.js
// and deliberately not stored. Storing them would be a second source of
// truth for where a file lives, and the two would disagree the first
// time the layout changed.

clipSchema.set('toJSON', {
  transform(doc, ret) {
    delete ret.__v;
    return ret;
  }
});

export const Clip = mongoose.model('Clip', clipSchema);
