/**
 * One-off migration: single-owner devices -> Membership collection.
 *
 * Before: Device.owner held one user id.
 * After:  a Membership { device, user, role:'owner' } row per device,
 *         and every device carries a unique shareCode.
 *
 * Safe to re-run - every step checks before it writes, so a run that
 * dies halfway (this cluster's TLS is flaky) can just be run again.
 *
 *   node scripts/migrate-memberships.mjs --dry-run   # report only
 *   node scripts/migrate-memberships.mjs             # apply
 *
 * Device.owner is deliberately left in place rather than unset, so this
 * is reversible: drop the memberships collection and the old field is
 * still there. Unset it in a follow-up once you're satisfied.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { Membership } from '../src/models/Membership.js';
import { Device } from '../src/models/Device.js';
import { generateShareCode } from '../src/utils/shareCode.js';

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

  // Raw collection, not the Mongoose model: legacy documents have an
  // `owner` field the schema no longer declares, and no `shareCode`,
  // which the schema now requires. Reading them through the model would
  // hide the first and reject writes on the second.
  const devicesCol = mongoose.connection.db.collection('devices');
  const devices = await devicesCol.find({}).toArray();
  console.log(`Found ${devices.length} device(s)\n`);

  // ---- Step 1: backfill shareCode --------------------------------
  // Must happen before the unique index is built: several devices with
  // no shareCode all read as null, and a unique index rejects that.
  const used = new Set(devices.map((d) => d.shareCode).filter(Boolean));
  let codesAdded = 0;

  for (const device of devices) {
    if (device.shareCode) continue;

    let code = generateShareCode();
    while (used.has(code)) code = generateShareCode();
    used.add(code);

    console.log(`  shareCode  ${device._id}  ${JSON.stringify(device.name)} -> ${code}`);
    if (!DRY_RUN) {
      await devicesCol.updateOne({ _id: device._id }, { $set: { shareCode: code } });
    }
    codesAdded++;
  }
  if (codesAdded === 0) console.log('  shareCode  (nothing to backfill)');

  // ---- Step 2: backfill owner memberships ------------------------
  console.log('');
  let membershipsAdded = 0;
  let alreadyPresent = 0;
  const orphans = [];

  for (const device of devices) {
    if (!device.owner) {
      orphans.push(device._id);
      continue;
    }

    const existing = await Membership.findOne({ device: device._id, user: device.owner });
    if (existing) {
      alreadyPresent++;
      continue;
    }

    console.log(`  membership ${device._id}  owner=${device.owner}`);
    if (!DRY_RUN) {
      await Membership.create({ device: device._id, user: device.owner, role: 'owner' });
    }
    membershipsAdded++;
  }
  if (membershipsAdded === 0) console.log('  membership (nothing to backfill)');

  // ---- Step 3: build indexes -------------------------------------
  if (!DRY_RUN) {
    console.log('\nSyncing indexes...');
    await Device.syncIndexes();
    await Membership.syncIndexes();
    console.log('  indexes in sync');
  } else {
    console.log('\n(dry-run: skipping index sync)');
  }

  // ---- Report ----------------------------------------------------
  console.log(`\n${label} summary`);
  console.log(`  devices scanned:       ${devices.length}`);
  console.log(`  shareCodes ${DRY_RUN ? 'to add' : 'added'}:    ${codesAdded}`);
  console.log(`  memberships ${DRY_RUN ? 'to add' : 'added'}:   ${membershipsAdded}`);
  console.log(`  memberships existing:  ${alreadyPresent}`);
  if (orphans.length) {
    console.log(`  !! devices with no owner (skipped, need manual attention):`);
    orphans.forEach((id) => console.log(`       ${id}`));
  }
  if (DRY_RUN) console.log('\nNothing was written. Re-run without --dry-run to apply.');

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('\nMigration failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
