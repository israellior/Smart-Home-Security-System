/**
 * A live view of the LiveKit room: who is in it, what they may publish,
 * and what they actually are publishing.
 *
 * Companion to watch.mjs, which watches the event pipeline. This watches
 * the media side, and exists because push-to-talk is hard to observe
 * from either end: the app shows you a button that turned gold, and the
 * Pi only shows you tracks it managed to subscribe to. Neither tells you
 * whether the grant landed, which is the step in between.
 *
 *   node scripts/watch-room.mjs --device porch-1
 *
 * Hold the talk button in the app and you should see three things in
 * order: the viewer's publish permission changing to `microphone`, an
 * audio track appearing under them, and both going away on release. A
 * grant that never arrives and a grant that arrives but never gets used
 * look completely different here, and they have completely different
 * causes.
 *
 * Reads through the server API, so it needs no hardware and no Pi - a
 * browser alone is enough to exercise the whole talk path.
 *
 * Polling rather than webhooks, for the same reason watch.mjs polls: a
 * second is far finer than a person can press a button, and nothing here
 * has to be set up anywhere.
 */
import 'dotenv/config';
import { RoomServiceClient, TrackSource, TrackType } from 'livekit-server-sdk';

const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;

const POLL_MS = 1000;

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1] ?? null;
}

const deviceId = arg('--device');

if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
  console.error('\nLIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be set in .env\n');
  process.exit(1);
}
if (!deviceId) {
  console.error('\n  node scripts/watch-room.mjs --device <device-id>\n');
  process.exit(1);
}

const room = `device-${deviceId}`;
const svc = new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);

const t = () => new Date().toLocaleTimeString();
const name = (enumObj, value) => String(enumObj[value] ?? value).toLowerCase();

/**
 * What a participant is allowed to publish, in the form the security
 * model is actually written in.
 *
 * `canPublishSources` supersedes `canPublish`, so an empty list next to
 * canPublish:true means "anything" rather than "nothing" - worth being
 * literal about, because reading it the other way round is how a working
 * grant gets mistaken for a missing one.
 */
function permissionOf(p) {
  const perm = p.permission;
  if (!perm) return '(unknown)';
  if (!perm.canPublish) return 'nothing';
  const sources = perm.canPublishSources ?? [];
  return sources.length === 0 ? 'anything' : sources.map((s) => name(TrackSource, s)).join(',');
}

function tracksOf(p) {
  return (p.tracks ?? []).map(
    (tr) => `${name(TrackType, tr.type)} ${name(TrackSource, tr.source)}${tr.muted ? ' (muted)' : ''}`
  );
}

/** One line per participant, compared against the last poll verbatim. */
function snapshot(participants) {
  const rows = new Map();
  for (const p of participants) {
    const tracks = tracksOf(p);
    rows.set(p.identity, `publish: ${permissionOf(p)}${tracks.length ? `   [${tracks.join(', ')}]` : ''}`);
  }
  return rows;
}

console.log('');
console.log(`  watching ${room}   (ctrl-c to stop)`);
console.log('');

let previous = new Map();
let warnedUnreachable = false;

async function poll() {
  let participants;
  try {
    participants = await svc.listParticipants(room);
    warnedUnreachable = false;
  } catch (err) {
    // A room that does not exist is the ordinary starting state rather
    // than a failure: LiveKit creates one when the first participant
    // joins and tears it down when the last one leaves. The same
    // distinction setCanTalk draws between someone being absent and the
    // server being unreachable, and it matters as much here - this is a
    // tool for telling those two apart.
    const notYet = /does not exist/i.test(err.message);

    // Whoever we were watching is gone either way.
    for (const identity of previous.keys()) console.log(`${t()}  - ${identity.padEnd(28)} left`);
    previous = new Map();

    // Said once per outage rather than every second, so the line stays
    // next to whatever it explains instead of burying it.
    if (!warnedUnreachable) {
      console.log(notYet ? `${t()}    room is empty - waiting` : `${t()}  ! cannot reach LiveKit: ${err.message}`);
      warnedUnreachable = true;
    }
    return;
  }

  const current = snapshot(participants);

  for (const [identity, line] of current) {
    const before = previous.get(identity);
    if (before === undefined) console.log(`${t()}  + ${identity.padEnd(28)} ${line}`);
    else if (before !== line) console.log(`${t()}  ~ ${identity.padEnd(28)} ${line}`);
  }
  for (const identity of previous.keys()) {
    if (!current.has(identity)) console.log(`${t()}  - ${identity.padEnd(28)} left`);
  }

  previous = current;
}

await poll();
setInterval(poll, POLL_MS);
