import { Event, RETENTION_MS, RETENTION_STARTS } from '../../models/Event.js';
import { Clip } from '../../models/Clip.js';
import { Device } from '../../models/Device.js';
import { storageConfigured, deleteClipObjects } from '../../config/storage.js';

/**
 * Deletes what nobody saved, a week after it arrived: the Activity row, its
 * clip in the bucket, and the Clip record. See RETENTION_MS in Event.js.
 *
 * A sweep of ours rather than a bucket lifecycle rule or a Mongo TTL index,
 * because neither can see the other. A lifecycle rule would delete saved
 * clips along with the rest - it knows object age, not "saved" - and a TTL
 * index would delete the rows and leave their videos in the bucket forever.
 * The decision needs the database and the deletes need the bucket, so it
 * lives where both are.
 *
 * Single instance, like presence and the talk floor - and unlike those,
 * harmless to run twice: two sweeps deleting the same rows both succeed.
 */

const SWEEP_EVERY_MS = 60 * 60 * 1000;

// After start-up rather than during it. A deploy should take the doorbells
// back first; a sweep that is an hour late deletes nothing it shouldn't.
const FIRST_SWEEP_AFTER_MS = 2 * 60 * 1000;

const BATCH = 500;

/**
 * The oldest `receivedAt` an unsaved row may have and still be shown.
 *
 * Nothing at all is due until the grace week after RETENTION_STARTS is
 * over: until then the only rows old enough to be past their own week
 * arrived before retention began, and those are given until it ends.
 */
export function retentionCutoff(now = Date.now()) {
  if (now < RETENTION_STARTS.getTime() + RETENTION_MS) return new Date(0);
  return new Date(now - RETENTION_MS);
}

/**
 * One batch: up to BATCH expired rows, gone from the database and the
 * bucket. Returns how many rows it removed.
 *
 * THE ORDER IS THE POINT. Rows first, guarded by `savedAt: null` in the
 * delete itself, then objects only for the rows that were actually deleted.
 * Somebody can press Save between this finding a row and deleting it; the
 * guard makes that row survive, and reading back which ids survived is what
 * stops its video being deleted from under it. The other order would delete
 * a just-saved clip's file and keep a row that plays nothing.
 *
 * The cost of the other failure - the rows went, a bucket delete did not -
 * is a few megabytes nobody can see, logged so it can be found.
 */
async function sweepBatch(cutoff) {
  const expired = await Event.find(
    { savedAt: null, receivedAt: { $lt: cutoff } },
    { device: 1, eventId: 1 }
  )
    .limit(BATCH)
    .lean();
  if (expired.length === 0) return 0;

  const ids = expired.map((e) => e._id);
  await Event.deleteMany({ _id: { $in: ids }, savedAt: null });
  const survivors = new Set(
    (await Event.find({ _id: { $in: ids } }, { _id: 1 }).lean()).map((e) => String(e._id))
  );
  const deleted = expired.filter((e) => !survivors.has(String(e._id)));

  // Grouped by doorbell, because an object key needs the doorbell's
  // deviceId and a Clip is unique per (device, eventId), not globally.
  const byDevice = new Map();
  for (const e of deleted) {
    const key = String(e.device);
    if (!byDevice.has(key)) byDevice.set(key, []);
    byDevice.get(key).push(e.eventId);
  }

  const devices = await Device.find({ _id: { $in: [...byDevice.keys()] } }, { deviceId: 1 }).lean();
  const slugs = new Map(devices.map((d) => [String(d._id), d.deviceId]));

  for (const [device, eventIds] of byDevice) {
    const clips = await Clip.find({ device, eventId: { $in: eventIds } }, { eventId: 1 }).lean();
    if (clips.length === 0) continue;

    const slug = slugs.get(device);
    if (storageConfigured && slug) {
      const failed = await deleteClipObjects(slug, clips.map((c) => c.eventId));
      if (failed > 0) {
        console.error(`Retention: ${failed} object delete(s) failed for ${slug}; left in the bucket`);
      }
    }
    await Clip.deleteMany({ device, eventId: { $in: clips.map((c) => c.eventId) } });
  }

  return deleted.length;
}

export async function sweepExpired(now = Date.now()) {
  const cutoff = retentionCutoff(now);
  let removed = 0;

  // Batches until one comes back short. Survivors (rows saved mid-sweep)
  // do not loop forever: they are no longer unsaved, so the next find does
  // not return them.
  for (;;) {
    const count = await sweepBatch(cutoff);
    removed += count;
    if (count < BATCH) break;
  }

  // Uploads that were granted and never confirmed. Their objects live under
  // pending/, which the bucket's own lifecycle rule clears after a day; the
  // records pointing at them are ours to clear.
  const stale = await Clip.deleteMany({ status: 'pending', createdAt: { $lt: cutoff } });

  if (removed > 0 || stale.deletedCount > 0) {
    console.log(
      `Retention: removed ${removed} event(s) older than a week, and ${stale.deletedCount} unconfirmed upload record(s)`
    );
  }
  return removed;
}

export function startRetentionSweep() {
  const run = () =>
    sweepExpired().catch((err) => {
      // Next hour tries again. Nothing is lost by a sweep failing - things
      // are only kept a little longer than promised.
      console.error('Retention sweep failed:', err.message);
    });

  // unref'd, so a pending sweep never holds the process open on shutdown.
  setTimeout(run, FIRST_SWEEP_AFTER_MS).unref();
  setInterval(run, SWEEP_EVERY_MS).unref();
}
