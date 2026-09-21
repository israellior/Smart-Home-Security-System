import { Event, RANK_BY_KIND } from '../../models/Event.js';
import { dispatchEventNotifications } from '../notifications/index.js';
import { eventBus, EVENT_INGESTED } from './eventBus.js';

/**
 * The one place an event enters the system.
 *
 * Both transports come through here - the signaling socket the daemon
 * uses, and the HTTP endpoint the app and tests use. That is the point:
 * the upgrade rule below must have exactly one implementation. Two
 * versions of "raise the kind, never lower it" is how a ring silently
 * becomes a motion on whichever path got it wrong.
 *
 * The four rules from docs/server-brief.md, and where each one lives:
 *
 *   1. Dedupe on (eventId, kind), never eventId alone - the unique index
 *      on { device, eventId } plus the rank comparison here.
 *   2. motion -> ring is an upgrade, ring -> motion is ignored, written
 *      as a maximum rather than a sequence because the two can arrive in
 *      either order after an outage.
 *   3. A permanent rejection is a decision, a transient failure is not.
 *      Rejections are returned; transient failures throw. See below.
 *   4. Order independence - nothing here requires anything to have
 *      arrived first.
 */

export const CREATED = 'created';
export const UPGRADED = 'upgraded';
export const DUPLICATE = 'duplicate';
export const REJECTED = 'rejected';

/**
 * Rule 3, and the reason this returns a rejection instead of throwing
 * one.
 *
 * A rejection is permanent: the device drops that alert and never sends
 * it again. A thrown error is transient, and the caller's contract is to
 * stay silent so the device retries. Conflating them is expensive in one
 * direction - answering "no" during a deploy or a database blip loses a
 * real doorbell press forever.
 *
 * So: only things that will still be wrong on the next attempt are
 * returned as REJECTED. Anything that might succeed later throws.
 */
function reject(reason) {
  return { outcome: REJECTED, reason, event: null };
}

export async function ingestEvent({ device, eventId, kind, at, meta }) {
  const rank = RANK_BY_KIND[kind];
  if (rank === undefined) return reject(`Unknown kind "${kind}"`);

  if (typeof eventId !== 'string' || eventId.length === 0 || eventId.length > 128) {
    return reject('eventId must be a non-empty string');
  }

  const firedAt = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(firedAt.getTime())) return reject('`at` is not a valid timestamp');

  const now = new Date();

  // One round trip for the common cases. $min on `at` rather than
  // $setOnInsert is what makes arrival order irrelevant: whichever of the
  // motion and the ring lands first, the event keeps the earliest sensor
  // time, which is when the visitor actually showed up.
  //
  // Note this update deliberately does NOT raise the kind. Reading the
  // stored rank back unchanged is what lets the upgrade below be a
  // compare-and-set rather than a blind write.
  let result;
  try {
    result = await Event.findOneAndUpdate(
      { device: device._id, eventId },
      {
        $setOnInsert: { kindRank: rank, receivedAt: now, meta: meta || {} },
        $min: { at: firedAt }
      },
      { upsert: true, new: true, includeResultMetadata: true }
    );
  } catch (err) {
    // Two first-time arrivals of the same event raced and the unique
    // index rejected the loser. Both are describing the same doorbell
    // press, so this is not a failure - pick the winner's row up and
    // carry on into the upgrade check below.
    if (err.code !== 11000) throw err;
    const existing = await Event.findOne({ device: device._id, eventId });
    if (!existing) throw err;
    result = { value: existing, lastErrorObject: { updatedExisting: true } };
  }

  const current = result.value;

  if (!result.lastErrorObject?.updatedExisting) {
    notify(device, current, CREATED);
    return { outcome: CREATED, event: current, reason: null };
  }

  if (current.kindRank < rank) {
    // Compare-and-set. The `$lt` in the filter is the whole guarantee:
    // this write can only ever raise the kind, so a stale ring arriving
    // after an upgrade already happened changes nothing, and two
    // concurrent upgrades produce one winner rather than two
    // notifications.
    const upgraded = await Event.findOneAndUpdate(
      { _id: current._id, kindRank: { $lt: rank } },
      { $set: { kindRank: rank, receivedAt: now } },
      { new: true }
    );

    if (upgraded) {
      // A ring is not the motion anyone was already told about - it is
      // new information, with its own per-person preference. Duplicates
      // below stay silent.
      notify(device, upgraded, UPGRADED);
      return { outcome: UPGRADED, event: upgraded, reason: null };
    }
  }

  // Either an exact retry, a ring -> motion attempt (ignored, by rule 2),
  // or an upgrade someone else won a millisecond ago. All three mean the
  // stored event is already correct and nobody needs telling again.
  return { outcome: DUPLICATE, event: current, reason: null };
}

/**
 * Deliberately not awaited, and deliberately in here rather than at the
 * call sites.
 *
 * Not awaited, because recording that motion happened is the job that
 * matters and telling people is best-effort on top of it - a doorbell
 * must get its acknowledgement even while a push provider times out. It
 * swallows its own errors for the same reason the old call site did: the
 * response is already gone and a rejection here would be unhandled.
 *
 * In here, because "notify on create and on upgrade, never on a
 * duplicate" is part of the dedupe rule, not a thing each transport
 * should be trusted to remember. This is the seam where a job queue
 * belongs at real volume - push the event id and let workers fan out.
 */
function notify(device, event, outcome) {
  // Anyone with the activity list open should see this now rather than on
  // their next refresh. Emitted before the push/email fan-out because it
  // is the cheap one, and a viewer already looking at the screen is the
  // person a notification was trying to reach anyway.
  //
  // Synchronous listeners only - an emit that threw would take the whole
  // ingest with it, so the signaling layer wraps its own sends.
  eventBus.emit(EVENT_INGESTED, { device, event, outcome });

  dispatchEventNotifications(device, event).catch((err) => {
    console.error(`Notification dispatch failed for event ${event._id}:`, err.message);
  });
}
