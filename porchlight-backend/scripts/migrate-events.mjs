/**
 * One-off migration: events gain a device-owned identity.
 *
 * Before: { type: 'motion' | 'ring' }, identified only by our own _id and
 *         timestamped only by createdAt - when the row was written.
 * After:  { eventId, kindRank, at, receivedAt }, identified by the pair
 *         (device, eventId) the device itself mints, and timestamped by
 *         when the sensor fired.
 *
 * Why each field:
 *
 *   eventId    the daemon resends an unacknowledged alert until we answer,
 *              so dedupe needs an id the *device* owns. Backfilled rows
 *              get a generated UUID - no real device ever sent them, and
 *              nothing will ever retry them, so any unique value is
 *              honest here.
 *   kindRank   0 = motion, 1 = ring. A number so "raise it, never lower
 *              it" is an atomic $max instead of read-compare-write.
 *   at         when the sensor fired. Unknowable for old rows, so it is
 *              set to createdAt: for events logged through the app those
 *              were the same moment anyway.
 *   receivedAt when we learned about it - also createdAt for old rows.
 *
 *   node scripts/migrate-events.mjs --dry-run   # report only
 *   node scripts/migrate-events.mjs             # apply
 *
 * Safe to re-run: only events that have no eventId yet are touched. The
 * old `type` field is left in place rather than unset, so this is
 * reversible - drop the new fields and the original is still there.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { Event, RANK_BY_KIND } from '../src/models/Event.js';

const DRY_RUN = process.argv.includes('--dry-run');
const label = DRY_RUN ? '[dry-run]' : '[apply]';

// Anything unrecognised becomes motion: the quieter of the two. Guessing
// upwards would invent doorbell presses that never happened.
const FALLBACK_RANK = RANK_BY_KIND.motion;

async function connectWithRetry(attempts = 5) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
      return;
    } catch (err) {
      console.log(`  connect attempt ${i}/${attempts} failed: ${err.message.split('\n')[0].slice(0, 80)}`);
      if (i === attempts) throw err;
    }
  }
}

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set');

  console.log(`${label} connecting...`);
  await connectWithRetry();
  console.log(`${label} connected\n`);

  // Raw collection: the Event schema no longer declares `type` as a
  // stored field - it is a virtual now - so reading through the model
  // would return the derived value instead of what is on disk.
  const eventsCol = mongoose.connection.db.collection('events');

  const pending = await eventsCol.find({ eventId: { $exists: false } }).toArray();
  const total = await eventsCol.countDocuments({});
  console.log(`Found ${total} event(s), ${pending.length} needing migration\n`);

  const counts = { motion: 0, ring: 0, unknown: 0 };
  let updated = 0;

  for (const event of pending) {
    const rank = RANK_BY_KIND[event.type];
    if (rank === undefined) counts.unknown++;
    else counts[event.type]++;

    // createdAt is always present - it predates this migration and every
    // row was written by Mongoose with timestamps on - but an event
    // somehow missing it would otherwise write an invalid Date and fail
    // the schema's `required` on the next save.
    const when = event.createdAt || new Date();

    const fields = {
      eventId: randomUUID(),
      kindRank: rank === undefined ? FALLBACK_RANK : rank,
      at: when,
      receivedAt: when
    };

    if (!DRY_RUN) {
      // Filtered on eventId still being absent, so two copies of this
      // script running at once cannot hand one event two ids.
      const res = await eventsCol.updateOne(
        { _id: event._id, eventId: { $exists: false } },
        { $set: fields }
      );
      updated += res.modifiedCount;
    } else {
      updated++;
    }
  }

  if (pending.length === 0) console.log('  (nothing to migrate)');
  else {
    console.log(`  motion:  ${counts.motion}`);
    console.log(`  ring:    ${counts.ring}`);
    if (counts.unknown > 0) console.log(`  unknown: ${counts.unknown}  -> treated as motion`);
  }

  if (!DRY_RUN) {
    // syncIndexes rather than createIndexes: this migration retires the
    // old { device, createdAt } index that the cursor used to page on,
    // and sync is what actually drops it. Leaving it would cost a write
    // on every insert to serve a query nothing makes any more.
    console.log('\nSyncing indexes...');
    await Event.syncIndexes();
    console.log('  indexes in sync');
  }

  console.log(`\n${label} summary`);
  console.log(`  events scanned:      ${total}`);
  console.log(`  events ${DRY_RUN ? 'to migrate' : 'migrated'}:   ${updated}`);
  if (DRY_RUN) console.log('\nNothing was written. Re-run without --dry-run to apply.');

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('\nMigration failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
