/**
 * Rings a doorbell that nobody is standing at.
 *
 * There is a script to provision hardware (mint-device.mjs) and one to
 * watch what arrives (watch.mjs), but nothing that makes anything arrive.
 * So until now the only way to see the unread badges, the "New" split on
 * the activity list, or a notification actually fire was to walk outside
 * and wave at a Raspberry Pi.
 *
 *   node scripts/ring.mjs --email you@example.com --password ...
 *   node scripts/ring.mjs --count 3                    # three presses
 *   node scripts/ring.mjs --kind motion                # motion, not a ring
 *   node scripts/ring.mjs --device "Back Gate" --count 5 --every 3
 *   node scripts/ring.mjs --upgrade                    # motion -> ring, one row
 *
 * Credentials can come from PORCHLIGHT_EMAIL / PORCHLIGHT_PASSWORD
 * instead of the flags, which is the nicer way to run it repeatedly.
 *
 * It signs in and posts to the running server rather than writing to the
 * database, and that is the whole point of it. The badge you are trying
 * to see is only half a stored row: the other half is ingestEvent
 * deciding this is new, emitting it on the event bus, and the signaling
 * layer pushing it to the browser you have open. A script that inserted
 * Events directly would produce rows that look right in Mongo and a UI
 * that does not move until you reload - which is precisely the bug you
 * would then go looking for.
 *
 * One thing worth knowing before you wonder why nothing appeared: having
 * the Activity page open for this doorbell marks alerts as seen as they
 * land, because that is what reading them means. Watch from the doorbell
 * list or the Overview tab.
 */
import 'dotenv/config';

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1] ?? null;
}
const has = (flag) => process.argv.includes(flag);

const API = arg('--api') || process.env.VITE_API_URL || 'http://localhost:4000/api';
const email = arg('--email') || process.env.PORCHLIGHT_EMAIL;
const password = arg('--password') || process.env.PORCHLIGHT_PASSWORD;
const wanted = arg('--device');
const count = Number(arg('--count') || 1);
const every = Number(arg('--every') || 0);
const kind = arg('--kind') || 'ring';
const upgrade = has('--upgrade');

const t = () => new Date().toLocaleTimeString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const USAGE = [
  'Need an account to raise alerts as.',
  '',
  '  node scripts/ring.mjs --email you@example.com --password secret',
  '  PORCHLIGHT_EMAIL=you@example.com PORCHLIGHT_PASSWORD=secret node scripts/ring.mjs'
].join('\n');

async function call(path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (err) {
    // By far the most likely failure, and the error Node raises for it
    // ("fetch failed") names none of it. The cause does carry the code
    // that tells the cases apart, and they want different things done:
    // ECONNREFUSED is a server that isn't up *yet* - during a --watch
    // restart, say, which is a second-long window you can simply retry -
    // while ENOTFOUND or ETIMEDOUT means --api is pointing somewhere
    // that was never going to answer.
    const cause = err.cause?.code || err.cause?.message || err.message;
    throw new Error(`Could not reach ${API} (${cause}) - is the server running?`);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${method} ${path} failed (${res.status})`);
  return data;
}

async function main() {
  if (!email || !password) throw new Error(USAGE);
  if (!['motion', 'ring'].includes(kind)) {
    throw new Error(`--kind must be motion or ring, not "${kind}"`);
  }

  const { token } = await call('/auth/login', { method: 'POST', body: { email, password } });

  const { devices } = await call('/devices', { token });
  if (devices.length === 0) {
    throw new Error('That account has no doorbells yet - add one in the app first.');
  }

  // Matched on name or id, case-insensitively, because the name is what
  // is on screen and the id is what is in the URL - those are the two
  // things you can actually see when deciding which doorbell to ring.
  const device = wanted
    ? devices.find((d) => d._id === wanted || d.name.toLowerCase().includes(wanted.toLowerCase()))
    : devices[0];

  if (!device) {
    throw new Error(
      `No doorbell matching "${wanted}". This account has: ${devices.map((d) => d.name).join(', ')}`
    );
  }

  /** The number the badges will be showing, read back from the server. */
  const unread = async () => {
    const { devices } = await call('/devices', { token });
    return devices.find((d) => d._id === device._id)?.newEventCount ?? 0;
  };

  console.log(`${device.name} - ${await unread()} unread to start\n`);

  for (let i = 1; i <= count; i++) {
    // A fresh id per press, so these are distinct rows rather than one
    // event retried - the dedupe rule is keyed on it.
    const eventId = crypto.randomUUID();

    const fire = async (k) => {
      const { outcome } = await call(`/devices/${device._id}/events`, {
        method: 'POST',
        token,
        body: { type: k, eventId, at: new Date().toISOString() }
      });
      console.log(`  ${t()}  ${k.padEnd(6)}  ${outcome.padEnd(9)}  ${await unread()} unread`);
    };

    if (upgrade) {
      // The interesting one to watch: same eventId, motion then ring. The
      // list shows a single row that changes its mind, and the badge goes
      // up by one rather than two - the upgrade rule doing its job.
      await fire('motion');
      await sleep(700);
      await fire('ring');
    } else {
      await fire(kind);
    }

    if (every > 0 && i < count) await sleep(every * 1000);
  }

  console.log('\ndone');
}

// One handler, one line. Every failure here is something the person
// running it can fix - a mistyped password, a server that isn't up - and
// a stack trace through undici tells them none of that. Setting exitCode
// rather than calling process.exit is deliberate too: exiting while a
// fetch socket is still closing trips an assertion inside libuv, which
// reads as a crash in the script rather than the tidy refusal it is.
main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
