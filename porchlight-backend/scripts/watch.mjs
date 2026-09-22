/**
 * A live view of what the server is actually receiving.
 *
 * For manual testing with real hardware: the doorbell is across the room,
 * the app only shows you the end of the pipeline, and most failures in
 * between are silent by design - an unacknowledged alert and a clip that
 * uploaded but was never confirmed both look like "nothing happened".
 * This shows each stage separately so you can see which one stopped.
 *
 *   node scripts/watch.mjs                 # everything
 *   node scripts/watch.mjs --device porch-1
 *
 * Polling rather than change streams: this cluster drops connections
 * often enough that a long-lived stream spends more time reconnecting
 * than watching, and two seconds is far finer than a person can act.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB } from './../src/config/db.js';
import { Device } from '../src/models/Device.js';
import { Event } from '../src/models/Event.js';
import { Clip } from '../src/models/Clip.js';
import '../src/models/User.js';

const POLL_MS = 2000;

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1] ?? null;
}
const only = arg('--device');

const t = (d) => new Date(d).toLocaleTimeString();

// Every read is retried: a dropped connection should make the watcher
// pause, not exit in the middle of the test it exists to observe.
async function safe(run, fallback) {
  for (let i = 1; i <= 3; i++) {
    try {
      return await run();
    } catch (err) {
      if (i === 3) return fallback;
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  return fallback;
}

await connectDB();

const filter = only ? { deviceId: only } : { deviceId: { $type: 'string' } };
const devices = await Device.find(filter);
if (devices.length === 0) {
  console.error(only ? `No provisioned device "${only}"` : 'No provisioned devices yet');
  process.exit(1);
}

const ids = devices.map((d) => d._id);
const nameOf = new Map(devices.map((d) => [String(d._id), d.deviceId]));

console.log(`watching ${devices.map((d) => d.deviceId).join(', ')} - ctrl-c to stop\n`);

// Start from now, so the existing backlog doesn't scroll past.
let since = new Date();
const presence = new Map(devices.map((d) => [String(d._id), d.connected]));
const clipState = new Map();

for (const [id, on] of presence) {
  console.log(`  ${t(Date.now())}  ${nameOf.get(id).padEnd(10)}  ${on ? 'ONLINE' : 'offline'}`);
}

setInterval(async () => {
  // Presence: the doorbell's socket coming and going.
  const fresh = await safe(() => Device.find({ _id: { $in: ids } }, { deviceId: 1, connected: 1 }), []);
  for (const d of fresh) {
    const key = String(d._id);
    if (presence.get(key) !== d.connected) {
      presence.set(key, d.connected);
      console.log(`  ${t(Date.now())}  ${d.deviceId.padEnd(10)}  ${d.connected ? 'ONLINE' : 'went offline'}`);
    }
  }

  // Alerts, by arrival rather than sensor time - an alert replayed after
  // an outage has an old `at` and would never show up in a window on it.
  const events = await safe(
    () => Event.find({ device: { $in: ids }, receivedAt: { $gt: since } }).sort({ receivedAt: 1 }),
    []
  );
  for (const e of events) {
    const lag = Math.round((e.receivedAt - e.at) / 1000);
    console.log(
      `  ${t(e.receivedAt)}  ${nameOf.get(String(e.device)).padEnd(10)}  ALERT  ${e.type.padEnd(6)}` +
        `  fired ${t(e.at)}${lag > 60 ? `  (delayed ${lag}s)` : ''}  ${e.eventId}`
    );
  }

  // Clips, reported at both stages: a grant issued and never confirmed
  // is the single most likely place for this pipeline to stop quietly.
  const clips = await safe(() => Clip.find({ device: { $in: ids }, updatedAt: { $gt: since } }), []);
  for (const c of clips) {
    const key = `${c.device}:${c.eventId}`;
    if (clipState.get(key) === c.status) continue;
    clipState.set(key, c.status);

    const label =
      c.status === 'pending'
        ? 'CLIP   upload-url issued, awaiting confirm'
        : `CLIP   stored  ${(c.bytes / 1024).toFixed(0)}KB` +
          `${c.durationMs ? `  ${(c.durationMs / 1000).toFixed(1)}s` : ''}${c.partial ? '  PARTIAL' : ''}`;
    console.log(`  ${t(c.updatedAt)}  ${nameOf.get(String(c.device)).padEnd(10)}  ${label}  ${c.eventId}`);
  }

  if (events.length || clips.length) since = new Date();
}, POLL_MS);

process.on('SIGINT', async () => {
  console.log('\nstopped');
  await mongoose.disconnect().catch(() => {});
  process.exit(0);
});
