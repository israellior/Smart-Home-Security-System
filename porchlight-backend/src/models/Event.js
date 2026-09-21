import mongoose from 'mongoose';

/**
 * A single motion or ring event.
 *
 * The device owns an event's identity, not us. `porchlightd` mints an
 * eventId when the sensor fires and keeps resending that same event until
 * it is acknowledged, so the pair (device, eventId) - never our _id - is
 * what says "this is the same doorbell press". See docs/server-brief.md
 * in the device repo for the wire contract.
 */

// Kind is stored as a rank, not a string, because the only write that
// ever changes it is "raise it, never lower it" and Mongo can express
// that atomically as $max on a number.
//
// $max on the *string* would appear to work - "ring" > "motion"
// lexicographically - which is a coincidence, not a rule. It survives
// exactly until someone adds a third kind, at which point the ordering
// silently becomes alphabetical and a real event gets downgraded at 3am.
const KIND_BY_RANK = ['motion', 'ring'];

export const RANK_BY_KIND = Object.fromEntries(KIND_BY_RANK.map((kind, rank) => [kind, rank]));
export const KINDS = KIND_BY_RANK;

const eventSchema = new mongoose.Schema(
  {
    device: { type: mongoose.Schema.Types.ObjectId, ref: 'Device', required: true, index: true },

    // The device's own identifier for this event - a UUID from the
    // daemon. Events raised through the app (or a test) get one generated
    // server-side, so every row has one and the dedupe rule has no
    // special cases.
    eventId: { type: String, required: true },

    kindRank: { type: Number, required: true, min: 0, max: KIND_BY_RANK.length - 1 },

    // When the sensor fired. NOT when we heard about it. An alert held
    // through a ten-minute outage still reports when the person was
    // actually at the door, so this is what the activity list shows and
    // orders by.
    at: { type: Date, required: true },

    // When we last learned something new about this event - its arrival,
    // or a later upgrade from motion to ring.
    //
    // Both timestamps are needed and neither substitutes for the other.
    // Unread counts against this one, because "new to you" means "arrived
    // since you last looked": an alert backfilled after an outage has an
    // old `at`, and counting unread by `at` would file it below the
    // watermark and mark it read without anyone having seen it.
    receivedAt: { type: Date, required: true },

    // Optional free-form details - e.g. { pixelsChanged: 2240 } from the
    // motion detector's frame-diff output.
    meta: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  { timestamps: true }
);

/**
 * `type` stays the field every caller reads - the frontend, the
 * notification dispatcher - but it is now derived rather than stored.
 *
 * Storing both the rank and the string would mean two sources of truth
 * for one fact and a way for them to disagree. A virtual cannot drift.
 */
eventSchema.virtual('type').get(function () {
  return KIND_BY_RANK[this.kindRank];
});

// Dedupe, and the reason retries are safe. The device resends the same
// (eventId, kind) for as long as it goes unacknowledged, so without this
// an hour offline becomes an hour of duplicate rows.
//
// Partial, so the index can exist before the backfill migration has run:
// pre-migration rows have no eventId at all, and a plain unique index
// would read every one of them as the same null and refuse to build.
eventSchema.index(
  { device: 1, eventId: 1 },
  { unique: true, partialFilterExpression: { eventId: { $type: 'string' } } }
);

// The activity list: newest-first by sensor time, paged by cursor.
eventSchema.index({ device: 1, at: -1 });

// Unread counts, which range-scan on arrival time instead. A third index
// is not free, but these two queries sort by genuinely different fields
// and the alternative is a collection scan per device on every load of
// the device list.
eventSchema.index({ device: 1, receivedAt: 1 });

// Virtuals have to be asked for explicitly, and `id` is one Mongoose adds
// by default - turned off so the payload gains `type` and nothing else.
eventSchema.set('id', false);
eventSchema.set('toJSON', {
  virtuals: true,
  transform(doc, ret) {
    delete ret.__v;
    delete ret.kindRank;
    return ret;
  }
});

export const Event = mongoose.model('Event', eventSchema);
