/**
 * One-off migration: notification preferences Device -> Membership.
 *
 * Before: Device.notifMotion / notifRing / notifDaily, shared by everyone
 *         with access, so one member muting alerts muted them for all.
 * After:  the same three fields on each Membership, so every person
 *         chooses their own alerts per doorbell.
 *
 * Each device's current values are copied onto all of its memberships,
 * so nobody's settings change on the day of the migration - they just
 * become individually editable from then on.
 *
 *   node scripts/migrate-notification-prefs.mjs --dry-run   # report only
 *   node scripts/migrate-notification-prefs.mjs             # apply
 *
 * Safe to re-run: only memberships that don't yet have the fields are
 * touched. The old Device fields are left in place rather than unset, so
 * this is reversible - drop the fields from Membership and the originals
 * are still there.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { Membership } from '../src/models/Membership.js';

const DRY_RUN = process.argv.includes('--dry-run');
const label = DRY_RUN ? '[dry-run]' : '[apply]';

const PREFS = ['notifMotion', 'notifRing', 'notifDaily'];
const DEFAULTS = { notifMotion: true, notifRing: true, notifDaily: false };

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

  // Raw collection: the Device schema no longer declares these fields,
  // so reading through the model would return undefined for all of them.
  const devicesCol = mongoose.connection.db.collection('devices');
  const devices = await devicesCol.find({}).toArray();
  console.log(`Found ${devices.length} device(s)\n`);

  let devicesTouched = 0;
  let membershipsUpdated = 0;

  for (const device of devices) {
    const values = {};
    for (const key of PREFS) {
      values[key] = typeof device[key] === 'boolean' ? device[key] : DEFAULTS[key];
    }

    // Only memberships that haven't been migrated yet. Using $exists on
    // one field as the marker keeps this idempotent, and updateMany does
    // it in a single round trip per device rather than one per member.
    const filter = { device: device._id, notifMotion: { $exists: false } };
    const pending = await Membership.countDocuments(filter);
    if (pending === 0) continue;

    const summary = PREFS.map((k) => `${k}=${values[k]}`).join(' ');
    console.log(`  ${device._id}  ${JSON.stringify(device.name)}  ->  ${pending} membership(s)`);
    console.log(`      ${summary}`);

    if (!DRY_RUN) {
      const res = await Membership.updateMany(filter, { $set: values });
      membershipsUpdated += res.modifiedCount;
    } else {
      membershipsUpdated += pending;
    }
    devicesTouched++;
  }

  if (devicesTouched === 0) console.log('  (nothing to migrate)');

  if (!DRY_RUN) {
    console.log('\nSyncing indexes...');
    await Membership.syncIndexes();
    console.log('  indexes in sync');
  }

  console.log(`\n${label} summary`);
  console.log(`  devices scanned:        ${devices.length}`);
  console.log(`  devices needing work:   ${devicesTouched}`);
  console.log(`  memberships ${DRY_RUN ? 'to update' : 'updated'}:  ${membershipsUpdated}`);
  if (DRY_RUN) console.log('\nNothing was written. Re-run without --dry-run to apply.');

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('\nMigration failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
