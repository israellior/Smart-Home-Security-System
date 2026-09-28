/**
 * One-off migration: the share code stops being a factory artifact.
 *
 * Before: every device was born with a share code, minting printed it
 *         beside the credential, and the first person to type it became
 *         the owner. A doorbell is bolted to the outside of a house with
 *         that code on a sticker on the case, so a photograph of the unit
 *         - by a delivery driver, a guest, someone who finds the
 *         packaging - was enough to take permanent ownership of a camera
 *         pointed at a front door.
 * After:  ownership comes from a one-time claim code, consumed by the
 *         first claim. Share codes are generated inside the app by an
 *         owner, are revocable, and are printed on nothing.
 *
 * Three things to do, and only the first is unavoidable:
 *
 *   1. Drop the plain unique index on shareCode. The field is now absent
 *      on most devices, so uniqueness has to be a partial index - and
 *      Mongo will not redefine `shareCode_1` in place. Left alone, the
 *      server's autoIndex hits IndexOptionsConflict on boot and every
 *      device with no share code collides on null.
 *
 *   2. Clear share codes from provisioned devices nobody owns. Those are
 *      exactly the factory-printed codes A6 is about: still live, still
 *      granting ownership to whoever types them first. The app now refuses
 *      to grant ownership through /join at all, so these grant nothing -
 *      but a code that grants nothing should not still be in the database
 *      looking like it does.
 *
 *   3. Report devices that are claimed by nobody and have no claim code.
 *      Those are units minted before claim codes existed: they can
 *      connect and report perfectly, and there is no way for anyone to
 *      become their owner. They need `mint-device.mjs --device-id <id>
 *      --force` and a re-flash. Nothing here can fix that, so it counts
 *      them rather than pretending.
 *
 *   node scripts/migrate-claim-codes.mjs --dry-run   # report only
 *   node scripts/migrate-claim-codes.mjs             # apply
 *
 * Safe to re-run: every step checks before it writes, and dropping an
 * index that is already gone is treated as success.
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

  const devices = mongoose.connection.db.collection('devices');

  // --- 1. the index -----------------------------------------------------
  const indexes = await devices.indexes();
  const existing = indexes.find((ix) => ix.name === 'shareCode_1');
  const isPartial = Boolean(existing?.partialFilterExpression);

  if (!existing) {
    console.log('  shareCode index      absent - Mongoose will build the partial one');
  } else if (isPartial) {
    console.log('  shareCode index      already partial, nothing to do');
  } else {
    console.log('  shareCode index      plain unique - must be dropped');
    if (!DRY_RUN) {
      await devices.dropIndex('shareCode_1');
      console.log('                       dropped. The partial one is built by the');
      console.log('                       schema on the next server start.');
    }
  }

  // --- 2. factory share codes on unowned hardware -----------------------
  //
  // "Provisioned and unowned" is the set that matters. A device somebody
  // owns has a share code because they or the old mint gave it one, and
  // taking it away would break sharing they are relying on today - they
  // can revoke it themselves now. A device with no hardware behind it was
  // created in the app by a user who already owns it.
  const ownedIds = await Membership.distinct('device', { role: 'owner' });
  const factoryCodeFilter = {
    shareCode: { $type: 'string' },
    deviceId: { $type: 'string' },
    _id: { $nin: ownedIds }
  };

  const factoryCodes = await Device.find(factoryCodeFilter, { deviceId: 1, shareCode: 1 }).lean();
  console.log(`\n  factory share codes  ${factoryCodes.length} on provisioned, unowned devices`);
  for (const d of factoryCodes) console.log(`                       ${d.deviceId}  ${d.shareCode}`);

  if (factoryCodes.length > 0 && !DRY_RUN) {
    const res = await Device.updateMany(factoryCodeFilter, { $unset: { shareCode: 1 } });
    console.log(`                       cleared ${res.modifiedCount}`);
  }

  // --- 3. hardware nobody can ever claim --------------------------------
  const unclaimable = await Device.find(
    {
      deviceId: { $type: 'string' },
      claimCodeHash: null,
      _id: { $nin: ownedIds }
    },
    { deviceId: 1, name: 1 }
  ).lean();

  console.log(`\n  unclaimable units    ${unclaimable.length}`);
  for (const d of unclaimable) console.log(`                       ${d.deviceId} (${d.name})`);
  if (unclaimable.length > 0) {
    console.log('');
    console.log('  These were minted before claim codes existed. They connect and');
    console.log('  report fine, but nobody can become their owner. Re-mint each:');
    for (const d of unclaimable) {
      console.log(`    node scripts/mint-device.mjs --device-id ${d.deviceId} --force`);
    }
    console.log('  ...then re-flash, or write the new certificate onto the card.');
  }

  console.log(`\n${label} done`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('\nFailed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
