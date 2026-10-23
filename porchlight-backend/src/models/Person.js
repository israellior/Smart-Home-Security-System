import mongoose from 'mongoose';

/**
 * Someone a doorbell knows by face.
 *
 * The name lives here and nowhere else. The doorbell is sent the person's id
 * and photos, makes its own codes from them, and says "p_3k9x2m" when they are
 * at the door; this is what turns that back into "Lior". A stolen doorbell
 * holds codes and ids and nothing that says whose.
 *
 * Belongs to a doorbell rather than to an account: the same front door is
 * shared by a household, and who it recognises is a fact about the door. Only
 * an owner adds or removes anyone - see faceController.js.
 *
 * The photos themselves are in the bucket, under faces/ - see
 * config/storage.js. This keeps what is known about each one.
 */
export const PHOTO_STATES = [
  'pending', // stored; the doorbell has not said yet
  'ok', // the doorbell found one clear face and coded it
  'failed' // the doorbell could not use it - `error` says why
];

const photoSchema = new mongoose.Schema(
  {
    photoId: { type: String, required: true },
    bytes: { type: Number, required: true },
    state: { type: String, enum: PHOTO_STATES, default: 'pending' },
    // The doorbell's own words for a failure - "no face", "face too small",
    // "more than one face", "not a picture", "could not download".
    error: { type: String, default: null },
    addedAt: { type: Date, default: Date.now }
  },
  { _id: false }
);

const personSchema = new mongoose.Schema(
  {
    device: { type: mongoose.Schema.Types.ObjectId, ref: 'Device', required: true },
    // What the doorbell knows them by. Random, short, and never derived from
    // the name: see services/faces.js.
    personId: { type: String, required: true },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    photos: { type: [photoSchema], default: [] },
    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  },
  { timestamps: true }
);

personSchema.index({ device: 1, personId: 1 }, { unique: true });

personSchema.set('toJSON', {
  transform(doc, ret) {
    delete ret.__v;
    return ret;
  }
});

export const Person = mongoose.model('Person', personSchema);
