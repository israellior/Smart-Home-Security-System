/**
 * Provision a doorbell. The only place a device credential is ever made.
 *
 * Run once per piece of hardware, by whoever builds it. It creates the
 * Device record and prints two secrets, each exactly once:
 *
 *   credential  pl_porch-1_...   write this onto the Pi
 *   share code  PORCH-7K2M9P     give this to whoever will own it
 *
 * The device is born with no owner. It boots, authenticates and starts
 * reporting whether or not anyone has claimed it - the first person to
 * submit the share code becomes the owner, everyone after is a member.
 * The device takes no part in that, which is the whole point: a doorbell
 * that comes up at 3am reports motion at 3am.
 *
 *   node scripts/mint-device.mjs --device-id porch-1 --name "Front Door"
 *   node scripts/mint-device.mjs --device-id porch-1 --force
 *   node scripts/mint-device.mjs --device-id porch-1 --attach <mongo id>
 *
 * --force re-mints an existing device: the new credential replaces the
 * old one, which stops working immediately. That is the recovery path for
 * a lost credential and the revocation path for a Pi that walked off.
 * There is no rotate-over-the-network endpoint by design, so this means
 * re-flashing the card.
 *
 * --attach binds hardware to a doorbell that already exists in the app
 * (one a user created by tapping "add doorbell"), rather than making a
 * new record. Its share code and members are left alone.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { Device } from '../src/models/Device.js';
import { Membership } from '../src/models/Membership.js';
// Imported for its side effect: registering the schema. Reporting the
// current owner populates Membership.user, and Mongoose can only resolve
// ref: 'User' if the model has been registered on this connection. In the
// server that happens via the route graph; a standalone script has no
// route graph, so it has to say so itself.
import '../src/models/User.js';
import { generateShareCode } from '../src/utils/shareCode.js';
import {
  generateDeviceCredential,
  isValidDeviceId,
  normalizeDeviceId
} from '../src/utils/deviceCredential.js';

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1] ?? null;
}
const has = (flag) => process.argv.includes(flag);

const deviceId = normalizeDeviceId(arg('--device-id'));
const name = arg('--name');
const location = arg('--location');
const attachTo = arg('--attach');
const force = has('--force');

/**
 * Retries every database call, not just the connect.
 *
 * This cluster's TLS handshake fails often enough that a single failure
 * mid-run is routine, and it clears the whole connection pool - so an
 * operation after a successful connect fails just as easily as the
 * connect did. For a tool someone runs while holding a Raspberry Pi,
 * "run it again" is a bad answer.
 */
async function retry(what, run, attempts = 6) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await run();
    } catch (err) {
      last = err;
      if (i < attempts) {
        console.log(`  ${what} attempt ${i}/${attempts} failed: ${err.message.split('\n')[0].slice(0, 70)}`);
        await new Promise((r) => setTimeout(r, 1200));
      }
    }
  }
  throw last;
}

async function connectWithRetry() {
  // Small pool for the same reason the server uses one: fewer concurrent
  // handshakes means fewer chances to trip the failure above.
  await retry('connect', () =>
    mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000, maxPoolSize: 5 })
  );
}

/**
 * Saving is retried too, which is only safe because Mongoose generates
 * the _id client-side: a retry writes the same document to the same id.
 * If an earlier attempt actually landed and we retried anyway, the insert
 * collides on _id - which means it worked, not that it failed.
 */
async function saveWithRetry(device) {
  await retry('save', async () => {
    try {
      await device.save();
    } catch (err) {
      if (err.code === 11000 && err.keyPattern?._id) return;
      throw err;
    }
  });
}

function usage(message) {
  console.error(`\n${message}\n`);
  console.error('  node scripts/mint-device.mjs --device-id <slug> [--name "Front Door"]');
  console.error('                               [--location "..."] [--force] [--attach <id>]\n');
  process.exit(1);
}

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set');
  if (!deviceId) usage('--device-id is required.');
  if (!isValidDeviceId(deviceId)) {
    usage(`"${deviceId}" is not a valid device id: 2-32 chars, lowercase letters, digits and hyphens.`);
  }

  await connectWithRetry();

  // Resolve which record this hardware belongs to, before minting
  // anything - a credential printed for a device that then fails to save
  // is a secret loose in a terminal for no reason.
  let device;
  if (attachTo) {
    if (!mongoose.isValidObjectId(attachTo)) usage(`--attach needs a device id; "${attachTo}" is not one.`);
    device = await retry('lookup', () => Device.findById(attachTo));
    if (!device) usage(`No doorbell with id ${attachTo}.`);
    if (device.credentialHash && !force) {
      usage(`${device.name} already has hardware provisioned. Re-run with --force to replace it.`);
    }
  } else {
    const existing = await retry('lookup', () => Device.findOne({ deviceId }));
    if (existing && !force) {
      usage(`"${deviceId}" is already provisioned. Re-run with --force to replace its credential.`);
    }
    device = existing || new Device({ shareCode: generateShareCode() });
  }

  const { credential, credentialHash } = generateDeviceCredential(deviceId);

  const replacing = Boolean(device.credentialHash);
  device.deviceId = deviceId;
  device.credentialHash = credentialHash;
  device.provisionedAt = new Date();
  if (name) device.name = name;
  if (location) device.location = location;

  try {
    await saveWithRetry(device);
  } catch (err) {
    if (err.code === 11000 && err.keyPattern?.deviceId) {
      usage(`Another doorbell is already provisioned as "${deviceId}".`);
    }
    if (err.code === 11000 && err.keyPattern?.shareCode) {
      usage('Share code collision - vanishingly unlikely, just run it again.');
    }
    throw err;
  }

  const owner = await retry('owner lookup', () =>
    Membership.findOne({ device: device._id, role: 'owner' }).populate('user', 'email')
  );

  console.log('');
  console.log(replacing ? '  RE-MINTED - the previous credential no longer works' : '  Provisioned');
  console.log('');
  console.log(`  doorbell     ${device.name}${device.location ? ` (${device.location})` : ''}`);
  console.log(`  device id    ${device.deviceId}`);
  console.log(`  record       ${device._id}`);
  console.log('');
  console.log('  ---- shown once, not recoverable ------------------------------');
  console.log('');
  console.log(`  credential   ${credential}`);
  console.log('               write to the Pi, readable only by the daemon');
  console.log('');

  if (owner) {
    console.log(`  owner        ${owner.user?.email || owner.user} (already claimed)`);
    console.log(`  share code   ${device.shareCode}   - for additional members`);
  } else {
    console.log(`  share code   ${device.shareCode}`);
    console.log('               unclaimed: whoever enters this first becomes the owner');
  }
  console.log('');
  console.log('  ---------------------------------------------------------------');
  console.log('');

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('\nFailed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
