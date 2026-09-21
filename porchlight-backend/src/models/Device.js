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
    // Notification preferences used to live here. They moved to
    // Membership, because they belong to a person's relationship with a
    // doorbell rather than to the doorbell itself - see
    // scripts/migrate-notification-prefs.mjs.
    //
    // True once real hardware has connected and reported in at least
    // once. Still nothing sets this: "connected" means *currently*, and
    // only a socket whose close event means something can answer that.
    // It belongs to the signaling layer. `lastContactAt` below is the
    // honest thing this layer can say.
    connected: { type: Boolean, default: false },
    // The code another user types to join this device. Unique index is
    // what actually guarantees no two devices share one; see
    // utils/shareCode.js for why the alphabet excludes 0/O and 1/I/L.
    shareCode: { type: String, required: true, unique: true, index: true },

    // --- Hardware identity ---------------------------------------------
    //
    // Everything above describes a doorbell as the app knows it, and
    // exists from the moment a user taps "add device" - with no hardware
    // behind it at all. Everything below is about a real Pi, and is
    // absent until one is paired.

    // The device's own name for itself - "porch-1". Distinct from `name`,
    // which a user can rename to "Back Gate" on a whim. This one appears
    // in URLs, in the alert payloads the daemon sends, and inside the
    // credential, so it is a lowercase slug and it does not change.
    deviceId: { type: String, default: undefined },

    // SHA-256 of the device's credential secret. Never the plaintext:
    // that is shown once at pairing and is unrecoverable afterwards, so
    // a dump of this collection does not let anyone speak as a doorbell.
    // See utils/deviceCredential.js for why SHA-256 and not bcrypt.
    credentialHash: { type: String, default: null },

    // The one-time code the owner types into the Pi, hashed, plus its
    // expiry. Cleared the moment it is redeemed - single use is what
    // stops a code screenshotted once from pairing a second Pi later.
    pairingCodeHash: { type: String, default: null },
    pairingExpiresAt: { type: Date, default: null },

    pairedAt: { type: Date, default: null },

    // When the hardware last authenticated against us. Deliberately not
    // named lastSeenAt: Membership.lastSeenAt is a *person's* read
    // watermark, and two fields with one name across two collections is
    // how the wrong one ends up in a query.
    lastContactAt: { type: Date, default: null }
  },
  { timestamps: true }
);

// Partial rather than sparse. A sparse unique index skips documents where
// the field is *missing*, but not ones where it is explicitly null - and
// every device created before pairing existed would collide on null the
// moment two of them were written. Filtering on $type: 'string' indexes
// exactly the paired devices and ignores the rest.
deviceSchema.index(
  { deviceId: 1 },
  { unique: true, partialFilterExpression: { deviceId: { $type: 'string' } } }
);

// Provisioning looks a device up *by* its pairing hash - it has no other
// handle on which device is being claimed - so this is the index that
// makes redeeming a code one seek instead of a collection scan.
deviceSchema.index(
  { pairingCodeHash: 1 },
  { partialFilterExpression: { pairingCodeHash: { $type: 'string' } } }
);

// Applies to every serialization path - res.json(), a populated
// sub-document, an array - rather than relying on each controller to
// remember. _id is kept deliberately: the frontend uses device._id.
//
// The three secret-bearing fields are stripped here for the same reason
// User strips passwordHash in its schema rather than in a controller:
// this holds no matter how a device document reaches a response, and a
// handler added later cannot forget it. None of them are useful to a
// client even in hashed form.
deviceSchema.set('toJSON', {
  transform(doc, ret) {
    delete ret.__v;
    delete ret.credentialHash;
    delete ret.pairingCodeHash;
    delete ret.pairingExpiresAt;
    return ret;
  }
});

export const Device = mongoose.model('Device', deviceSchema);
