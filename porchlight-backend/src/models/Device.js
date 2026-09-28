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
    // The code another user types to join this device - a flatmate, a
    // neighbour, someone who feeds the cat.
    //
    // Optional, and that is the A6 change: a share code is no longer a
    // factory artifact. It used to be minted with the hardware and
    // printed alongside the credential, which made the code that grants
    // permanent access to a camera something anyone could read off the
    // back of a case. Now the owner generates one inside the app when
    // they actually want to share, revokes it by unsetting this, and
    // rotates it by generating another. Nothing prints it.
    //
    // The one-time code that ships on the hardware is claimCodeHash
    // below, and the two must never be conflated - see
    // utils/claimCode.js for what that would cost.
    //
    // Uniqueness is a partial index rather than `unique: true` here, for
    // the reason spelled out under deviceId: a plain unique index
    // collides on the *second* device with no share code.
    shareCode: { type: String, default: undefined },

    // --- Hardware identity ---------------------------------------------
    //
    // Everything above describes a doorbell as the app knows it.
    // Everything below is about a real Pi, and is written once by
    // scripts/mint-device.mjs when the hardware is built.
    //
    // A device does not enrol itself over the network and takes no part
    // in deciding who owns it. It is provisioned with a credential,
    // boots, authenticates and reports - whether or not anyone has
    // claimed it yet. Ownership is a separate question, answered by
    // Membership.

    // The device's own name for itself - "porch-1". Distinct from `name`,
    // which a user can rename to "Back Gate" on a whim. This one appears
    // in URLs, in the alert payloads the daemon sends, and inside the
    // credential, so it is a lowercase slug and it does not change.
    deviceId: { type: String, default: undefined },

    // SHA-256 of the device's credential secret. Never the plaintext:
    // that is printed once at mint time and is unrecoverable afterwards,
    // so a dump of this collection does not let anyone speak as a
    // doorbell. See utils/deviceCredential.js for why SHA-256, not bcrypt.
    credentialHash: { type: String, default: null },

    provisionedAt: { type: Date, default: null },

    // When the hardware last authenticated against us. Deliberately not
    // named lastSeenAt: Membership.lastSeenAt is a *person's* read
    // watermark, and two fields with one name across two collections is
    // how the wrong one ends up in a query.
    lastContactAt: { type: Date, default: null },

    // --- Claiming -------------------------------------------------------
    //
    // The one-time code that turns a boxed doorbell into somebody's
    // doorbell. Generated at mint time, printed on the sticker, shown on
    // the setup page, and consumed by the first successful claim.
    //
    // Keyed hash, not a bare digest: a six-character code has about
    // thirty bits in it, so an unsalted SHA-256 column is readable
    // straight out of a database dump by anyone willing to spend a minute
    // on it. utils/claimCode.js has the full argument.
    claimCodeHash: { type: String, default: null },

    // When the code was spent. Non-null is what makes a second person
    // holding the same photograph get "that code has already been used"
    // rather than a second membership. Kept rather than just clearing the
    // hash, because "already claimed" and "never had a code" want
    // different answers, and support needs to know which happened.
    claimedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

// Partial rather than sparse. A sparse unique index skips documents where
// the field is *missing*, but not ones where it is explicitly null - and
// every device without hardware behind it would collide on null the
// moment two of them were written. Filtering on $type: 'string' indexes
// exactly the provisioned devices and ignores the rest.
deviceSchema.index(
  { deviceId: 1 },
  { unique: true, partialFilterExpression: { deviceId: { $type: 'string' } } }
);

// Same shape, same reason. A share code is now absent on most devices -
// every doorbell nobody has shared - so `unique: true` on the path would
// fail on the second one of those.
//
// NOTE: this replaces a plain unique index that older deployments still
// carry. Mongo will not redefine `shareCode_1` in place, so the old one
// has to be dropped first: scripts/migrate-claim-codes.mjs does that.
deviceSchema.index(
  { shareCode: 1 },
  { unique: true, partialFilterExpression: { shareCode: { $type: 'string' } } }
);

// The claim lookup. Unique so that two devices minted with the same
// random code is a duplicate-key error the mint retries, rather than two
// doorbells one code can claim - the index is the guarantee, the 887
// million values only make it rare.
deviceSchema.index(
  { claimCodeHash: 1 },
  { unique: true, partialFilterExpression: { claimCodeHash: { $type: 'string' } } }
);

/**
 * Four states, because `connected` is a boolean and a doorbell that has
 * never been plugged in looks exactly like one that is unplugged.
 *
 * That distinction is the whole of what a customer stares at during
 * setup. They type a claim code and then watch a screen until something
 * changes, and `connected: false` cannot tell *it has not been plugged in
 * yet* from *it was, and something went wrong* - which are the two
 * halves of that wait, and have completely different next actions.
 *
 *   unprovisioned    no hardware exists for this doorbell    mint one
 *   never-connected  provisioned, has never reported in      check power and wi-fi,
 *                                                           check the card got the
 *                                                           right credential
 *   offline          has reported in before, not now         wait, or check power
 *   online           a socket is open right now              nothing
 *
 * Derived rather than stored: every input is already here, and a stored
 * copy is a thing that can disagree with them.
 */
export function deviceStatus(device) {
  if (!device.deviceId) return 'unprovisioned';
  if (device.connected) return 'online';
  return device.lastContactAt ? 'offline' : 'never-connected';
}

// Applies to every serialization path - res.json(), a populated
// sub-document, an array - rather than relying on each controller to
// remember. _id is kept deliberately: the frontend uses device._id.
//
// credentialHash is stripped here for the same reason User strips
// passwordHash in its schema rather than in a controller: this holds no
// matter how a device document reaches a response, and a handler added
// later cannot forget it. It is not useful to a client even hashed.
deviceSchema.set('toJSON', {
  transform(doc, ret) {
    delete ret.__v;
    delete ret.credentialHash;
    // Same rule as the credential: a hash of a secret is still a secret,
    // and this one is short enough that handing it out would matter.
    delete ret.claimCodeHash;
    // Attached here, not in a controller, so it is on the device however
    // the document reaches a response - and so a handler added later
    // cannot serve a doorbell with no status on it.
    ret.status = deviceStatus(doc);
    return ret;
  }
});

export const Device = mongoose.model('Device', deviceSchema);
