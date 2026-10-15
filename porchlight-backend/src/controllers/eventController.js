import { randomUUID } from 'node:crypto';
import { Event, RANK_BY_KIND, RETENTION_MS } from '../models/Event.js';
import { Clip } from '../models/Clip.js';
import { User } from '../models/User.js';
import { ingestEvent, CREATED, REJECTED } from '../services/events/ingestEvent.js';
import { retentionCutoff } from '../services/events/retention.js';
import { eventBus, EVENT_SAVED } from '../services/events/eventBus.js';

/**
 * Attaches clip metadata to a page of events.
 *
 * One query for the whole page, not one per row: the same `$in` shape
 * the notification dispatch uses, and for the same reason - a per-row
 * lookup would turn a 50-event page into 51 round trips.
 *
 * No URL here. A playback URL is short-lived by design, and a list that
 * was loaded ten minutes ago would hand out URLs that have already
 * expired. The frontend asks for one when someone actually presses play.
 */
async function withClips(events, deviceId) {
  if (events.length === 0) return [];

  const clips = await Clip.find({
    device: deviceId,
    eventId: { $in: events.map((e) => e.eventId) },
    status: 'stored'
  });

  const byEventId = new Map(clips.map((c) => [c.eventId, c]));

  return events.map((event) => {
    const json = event.toJSON();
    const clip = byEventId.get(event.eventId);
    if (clip) {
      json.clip = { durationMs: clip.durationMs, partial: clip.partial, bytes: clip.bytes };
    }
    return json;
  });
}

// Both handlers run behind requireDeviceAccess, so req.device is already
// loaded and already confirmed to belong to this caller. That's why the
// old assertOwnsDevice helper is gone - the check moved to the route
// definition, where forgetting it means the handler has no device at all
// rather than quietly reading someone else's.

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * What Activity's filters ask for. On the server rather than over the
 * page the app already has, because a page is fifty rows: a busy doorbell's
 * motion alerts can fill it, and "Saved" filtered client-side would be
 * "saved, among the newest fifty" - missing exactly the old clips it exists
 * to find.
 *
 * Each is a filter after the { device, at } seek rather than an index of
 * its own: retention keeps a doorbell to a week of rows plus what it saved,
 * so the scan behind any of these is short.
 */
const FILTERS = {
  ring: { kindRank: RANK_BY_KIND.ring },
  motion: { kindRank: RANK_BY_KIND.motion },
  live: { kindRank: RANK_BY_KIND.live },
  saved: { savedAt: { $ne: null } }
};

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

  const filter = req.query.filter || 'all';
  if (filter !== 'all' && !FILTERS[filter]) {
    return res.status(400).json({ error: `Unknown filter "${filter}"` });
  }

  const query = { device: req.device._id, ...FILTERS[filter] };
  const conditions = [];

  // Saved, or still inside the week. The sweep deletes the rest within the
  // hour; this is what makes them disappear on time rather than then.
  if (filter !== 'saved') {
    conditions.push({
      $or: [{ savedAt: { $ne: null } }, { receivedAt: { $gte: retentionCutoff() } }]
    });
  }

  if (req.query.before) {
    const cursor = decodeCursor(req.query.before);
    if (!cursor) return res.status(400).json({ error: 'Invalid cursor' });
    // Strictly "older than the cursor": earlier timestamp, or the same
    // timestamp with a lower id.
    conditions.push({
      $or: [{ at: { $lt: cursor.at } }, { at: cursor.at, _id: { $lt: cursor.id } }]
    });
  }

  if (conditions.length > 0) query.$and = conditions;

  // One extra row tells us whether another page exists without a second
  // countDocuments over the whole collection.
  const events = await Event.find(query)
    .sort({ at: -1, _id: -1 })
    .limit(limit + 1);

  const hasMore = events.length > limit;
  if (hasMore) events.pop();

  // Cursor from the document, not the serialized form: encodeCursor
  // reads event.at as a Date, and toJSON has already turned it into a
  // string by the time withClips is done.
  const nextCursor = hasMore ? encodeCursor(events[events.length - 1]) : null;

  return res.json({
    events: await withClips(events, req.device._id),
    nextCursor,
    // So the app can say how long things are kept, and know when unsaving
    // an old row would delete it, without a copy of the number to drift.
    retentionMs: RETENTION_MS
  });
}

/**
 * Keep a row past the week, or stop keeping it.
 *
 * Idempotent both ways - saving a saved row answers with it as it is, and
 * keeps whoever saved it first - so a double tap or a retry is harmless.
 * Addressed by the device's eventId, like the clip it is usually about.
 *
 * Unsaving a row older than a week makes it due at once: listEvents stops
 * returning it and the next sweep deletes it and its clip. The app asks
 * before doing that, because it cannot be undone.
 */
async function setSaved(req, res, saved) {
  const { eventId } = req.params;
  const where = { device: req.device._id, eventId };

  let update;
  if (saved) {
    const me = await User.findById(req.userId, { name: 1 }).lean();
    update = { savedAt: new Date(), savedBy: { id: String(req.userId), name: me?.name ?? null } };
  } else {
    update = { savedAt: null, savedBy: null };
  }

  // The guard on savedAt is what makes a repeat a no-op rather than a
  // second write - and what stops a second "save" renaming who saved it.
  const changed = await Event.findOneAndUpdate(
    { ...where, savedAt: saved ? null : { $ne: null } },
    { $set: update },
    { new: true }
  );
  const event = changed || (await Event.findOne(where));
  if (!event) return res.status(404).json({ error: 'No such event on this doorbell' });

  if (changed) {
    // Best-effort, like every push: the save happened either way.
    try {
      eventBus.emit(EVENT_SAVED, { device: req.device, event });
    } catch (err) {
      console.error(`Save push failed for ${eventId}:`, err.message);
    }
  }
  return res.json({ event: event.toJSON() });
}

export const saveEvent = (req, res) => setSaved(req, res, true);
export const unsaveEvent = (req, res) => setSaved(req, res, false);

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
