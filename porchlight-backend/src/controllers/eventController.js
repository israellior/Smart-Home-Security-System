import { Event } from '../models/Event.js';
import { dispatchEventNotifications } from '../services/notifications/index.js';

// Both handlers run behind requireDeviceAccess, so req.device is already
// loaded and already confirmed to belong to this caller. That's why the
// old assertOwnsDevice helper is gone - the check moved to the route
// definition, where forgetting it means the handler has no device at all
// rather than quietly reading someone else's.

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

// A cursor pins an exact position in the { createdAt desc, _id desc }
// ordering. Both halves are needed: createdAt alone would skip or repeat
// events sharing a timestamp, which is exactly what happens when a
// motion detector fires several frames in the same second.
function encodeCursor(event) {
  return Buffer.from(`${event.createdAt.toISOString()}|${event._id}`).toString('base64url');
}

function decodeCursor(cursor) {
  try {
    const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    const createdAt = new Date(iso);
    if (Number.isNaN(createdAt.getTime()) || !id) return null;
    return { createdAt, id };
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
    query.$or = [
      { createdAt: { $lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, _id: { $lt: cursor.id } }
    ];
  }

  // One extra row tells us whether another page exists without a second
  // countDocuments over the whole collection.
  const events = await Event.find(query)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1);

  const hasMore = events.length > limit;
  if (hasMore) events.pop();

  return res.json({
    events,
    nextCursor: hasMore ? encodeCursor(events[events.length - 1]) : null
  });
}

export async function createEvent(req, res) {
  const { type, meta } = req.body;

  if (!['motion', 'ring'].includes(type)) {
    return res.status(400).json({ error: 'type must be "motion" or "ring"' });
  }

  const event = await Event.create({ device: req.device._id, type, meta: meta || {} });

  // Acknowledge first, then notify. A doorbell must get its 201 even if
  // a push service is timing out - recording that motion happened is the
  // job that matters, and telling people is best-effort on top of it.
  res.status(201).json({ event });

  // Nothing awaits this, so it must swallow its own errors: the response
  // is already sent and a rejection here would otherwise be unhandled.
  //
  // This is the seam where a job queue belongs at real volume - push the
  // event id onto a queue and let workers fan out, so a slow provider
  // can't build up in-process work. Callers wouldn't change.
  dispatchEventNotifications(req.device, event).catch((err) => {
    console.error(`Notification dispatch failed for event ${event._id}:`, err.message);
  });
}
