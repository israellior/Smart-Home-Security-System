import mongoose from 'mongoose';

/**
 * One software release for the doorbells: a signed RAUC bundle in the
 * bucket under releases/<version>.raucb, and what the app says about it.
 *
 * Signing happens on the build machine and nowhere else - the server never
 * holds the key and never needs to. A bundle that was not signed by it is
 * refused by RAUC on the doorbell, whatever this collection says, which is
 * what makes a compromised server unable to put code on anyone's door.
 *
 * The newest published release is the one every doorbell is brought to.
 * Publishing an older version again is therefore how a fleet is rolled back.
 */
const releaseSchema = new mongoose.Schema(
  {
    // Exactly the `version=` in the bundle's manifest, which is what the
    // doorbell reports back once it is running it.
    version: { type: String, required: true },
    notes: { type: String, default: '' },
    bytes: { type: Number, required: true },
    sha256: { type: String, required: true },
    // uploading - a grant was issued, the bundle may not be there yet
    // published - verified in the bucket, offered to doorbells
    status: { type: String, enum: ['uploading', 'published'], default: 'uploading' },
    publishedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

releaseSchema.index({ version: 1 }, { unique: true });
releaseSchema.index({ status: 1, publishedAt: -1 });

releaseSchema.set('toJSON', {
  transform(doc, ret) {
    delete ret.__v;
    return ret;
  }
});

export const Release = mongoose.model('Release', releaseSchema);
