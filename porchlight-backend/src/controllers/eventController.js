import { randomUUID } from 'node:crypto';
import { Event } from '../models/Event.js';
import { ingestEvent, CREATED, REJECTED } from '../services/events/ingestEvent.js';

// Both handlers run behind requireDeviceAccess, so req.device is already
// loaded and already confirmed to belong to this caller. That's why the
// old assertOwnsDevice helper is gone - the check moved to the route
// definition, where forgetting it means the handler has no device at all
// rather than quietly reading someone else's.

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

// A cursor pins an exact position in the { at desc, _id desc } ordering.
// Both halves are needed: `at` alone would skip or repeat events sharing
// a timestamp, which is exactly what happens when a motion detector fires
// several frames in the same second.
//
// Ordered by `at` - sensor time - rather than by arrival, so the list
// reads as the day actually happened. An alert backfilled after an outage
// slots into the evening it belongs to instead of appearing at the top
// pretending to be recent.
function encodeCursor(event) {
  return Buffer.from(`${event.at.toISOString()}|${event._id}`).toString('base64url');
}

function decodeCursor(cursor) {
  try {
    const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    const at = new Date(iso);
    if (Number.isNaN(at.getTime()) || !id) return null;
    return { at, id };
  } catch (err) {
    return null;
  }
}

/**
 * Newest events first, paged by cursor.
 *
 * Keyset pagination rather than skip/limit: `.skip(n)` makes Mongo walk
 * and discard n documents, so page 1000 costs a thousand times page 1.
 * A cursor turns every page into the same indexed range seek on
 * { device, createdAt } - page 1 and page 10,000 cost the same.
 */
export async function listEvents(req, res) {
  const requested = Number.parseInt(req.query.limit, 10);
  const limit = Math.min(Number.isNaN(requested) ? DEFAULT_LIMIT : Math.max(requested, 1), MAX_LIMIT);

  const query = { device: req.device._id };

  if (req.query.before) {
    const cursor = decodeCursor(req.query.before);
    if (!cursor) return res.status(400).json({ error: 'Invalid cursor' });
    // Strictly "older than the cursor": earlier timestamp, or the same
    // timestamp with a lower id.
    query.$or = [{ at: { $lt: cursor.at } }, { at: cursor.at, _id: { $lt: cursor.id } }];
  }

  // One extra row tells us whether another page exists without a second
  // countDocuments over the whole collection.
  const events = await Event.find(query)
    .sort({ at: -1, _id: -1 })
    .limit(limit + 1);

  const hasMore = events.length > limit;
  if (hasMore) events.pop();

  return res.json({
    events,
    nextCursor: hasMore ? encodeCursor(events[events.length - 1]) : null
  });
}

/**
 * The HTTP way in. Still behind a *user's* token, so this is the app's
 * path and the one tests use - a real doorbell will arrive on the
 * signaling socket instead. Both call the same ingestEvent, which is
 * where the dedupe and upgrade rules live.
 *
 * `eventId` and `at` are accepted but optional here, because a person
 * tapping a button in the app has neither. Generating them keeps every
 * row shaped the same, so the dedupe rule needs no special case for
 * app-raised events.
 */
export async function createEvent(req, res) {
  const { type, meta, eventId, at } = req.body;

  // `??`, not `||`. Absent means "the caller has none, make one up";
  // present-but-empty means the caller tried to supply one and got it
  // wrong, which should be told rather than silently papered over with a
  // random id that then dedupes against nothing.
  const result = await ingestEvent({
    device: req.device,
    eventId: eventId ?? randomUUID(),
    kind: type,
    at: at ?? new Date(),
    meta
  });

  if (result.outcome === REJECTED) {
    return res.status(400).json({ error: result.reason });
  }

  // 201 only when a row appeared. A retry or an upgrade is a 200: the
  // caller's request was accepted and acted on, but it did not create
  // anything, and saying "created" to a device replaying an hour of
  // backlog would be a lie told several hundred times.
  const status = result.outcome === CREATED ? 201 : 200;
  return res.status(status).json({ event: result.event, outcome: result.outcome });
}
