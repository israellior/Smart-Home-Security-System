/**
 * One-off migration: pairing is gone; devices are provisioned offline.
 *
 * Before: a device bootstrapped its credential over the network by
 *         redeeming a one-time code the owner minted in the app, so
 *         Device carried pairingCodeHash and pairingExpiresAt.
 * After:  scripts/mint-device.mjs writes the credential at build time.
 *         There is no enrolment endpoint, no code to expire, and no
 *         unauthenticated route left in the app.
 *
 * This drops the two dead fields and renames pairedAt -> provisionedAt,
 * because "paired" no longer describes anything that happens.
 *
 *   node scripts/migrate-drop-pairing.mjs --dry-run   # report only
 *   node scripts/migrate-drop-pairing.mjs             # apply
 *
 * Safe to re-run: the $unset and $rename are no-ops once applied, and
 * both are filtered on the fields still existing.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { Device } from '../src/models/Device.js';
import { Membership } from '../src/models/Membership.js';

const DRY_RUN = process.argv.includes('--dry-run');
const label = DRY_RUN ? '[dry-run]' : '[apply]';

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

  // Raw collection: the schema no longer declares these fields, so a
  // model query cannot see them.
  const devices = mongoose.connection.db.collection('devices');

  const withPairing = await devices.countDocuments({
    $or: [{ pairingCodeHash: { $exists: true } }, { pairingExpiresAt: { $exists: true } }]
  });
  const withPairedAt = await devices.countDocuments({ pairedAt: { $exists: true } });

  console.log(`  devices carrying pairing fields: ${withPairing}`);
  console.log(`  devices with pairedAt to rename: ${withPairedAt}`);

  // Duplicate owners would make the new partial unique index unbuildable,
  // and finding that out during a deploy is worse than finding it here.
  const dupeOwners = await Membership.aggregate([
    { $match: { role: 'owner' } },
    { $group: { _id: '$device', n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } }
  ]);
  console.log(`  doorbells with more than one owner: ${dupeOwners.length}`);
  if (dupeOwners.length > 0) {
    console.log('    ^ these must be resolved by hand before the owner index can build:');
    for (const d of dupeOwners) console.log(`      device ${d._id}: ${d.n} owners`);
  }

  if (!DRY_RUN) {
    const unset = await devices.updateMany(
      { $or: [{ pairingCodeHash: { $exists: true } }, { pairingExpiresAt: { $exists: true } }] },
      { $unset: { pairingCodeHash: '', pairingExpiresAt: '' } }
    );
    const renamed = await devices.updateMany(
      { pairedAt: { $exists: true } },
      { $rename: { pairedAt: 'provisionedAt' } }
    );
    console.log(`\n  cleared pairing fields on ${unset.modifiedCount} device(s)`);
    console.log(`  renamed pairedAt on ${renamed.modifiedCount} device(s)`);

    // syncIndexes, not createIndexes: this retires the pairingCodeHash
    // index, and sync is what actually drops it. It also builds the new
    // one-owner-per-device index on Membership.
    console.log('\nSyncing indexes...');
    await Device.syncIndexes();
    await Membership.syncIndexes();
    console.log('  indexes in sync');
  }

  if (DRY_RUN) console.log('\nNothing was written. Re-run without --dry-run to apply.');

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('\nMigration failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
