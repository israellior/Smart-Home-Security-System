import { WebSocketServer } from 'ws';
import { Device } from '../models/Device.js';
import { ingestEvent, REJECTED } from '../services/events/ingestEvent.js';
import { eventBus, EVENT_INGESTED, CLIP_STORED } from '../services/events/eventBus.js';
import { authenticate } from './authenticate.js';
import {
  talkFloorBus,
  TALK_FLOOR_CHANGED,
  releaseIfHeld,
  releaseWhoeverHolds
} from '../services/media/talkFloor.js';
import {
  recordingFloorBus,
  RECORDING_FLOOR_CHANGED,
  whoIsRecording,
  releaseRecordingIfHeld
} from '../services/media/recordingFloor.js';
import * as registry from './registry.js';
import {
  ROLE_DEVICE,
  ROLE_BROWSER,
  CLOSE_REPLACED,
  CLOSE_UNAUTHORIZED,
  CLOSE_NO_HELLO,
  CLOSE_TRY_LATER
} from './registry.js';

/**
 * The signaling socket - what replaces the device repo's LAN-only
 * server.js stub.
 *
 * It carries alerts up from the doorbell, viewer requests down to it, and
 * new events out to anyone with the activity list open. It does not carry
 * media: that is the SFU's job, and this server is never in that path.
 */

// A socket that connects and says nothing is either broken or probing.
const HELLO_TIMEOUT_MS = 10_000;

// A doorbell that loses power does not close its socket - the TCP
// connection simply stops answering, and without this the app would show
// "Connected and watching" indefinitely for a device that is unplugged.
// Ping/pong is the only thing that makes `connected` mean "right now".
const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * How many pings may go unanswered before the socket is terminated.
 *
 * Two, not one. The device answers pings from inside the read loop of
 * `websocket-client`, which is normally instant - but that loop shares a
 * process with a clip upload saturating a home uplink, and one late pong
 * is not a dead doorbell.
 *
 * A false terminate is not free: it costs a reconnect, a presence flap to
 * every browser watching, and a fresh hello. Counting to two costs at
 * most thirty extra seconds of believing in a doorbell that has gone, and
 * nothing depends on this being the fast detector - the device runs its
 * own 20s ping with a 10s timeout, so it notices a broken link before we
 * do either way.
 */
const MISSED_PINGS_BEFORE_TERMINATE = 2;

/**
 * How long "somebody wants to watch" outlives the doorbell being offline.
 *
 * Thirty seconds, and the ceiling matters more than the floor. The
 * bridge's reconnect backoff starts at a second or two, so the common
 * case is a doorbell that is back well inside this window and a viewer
 * who never learns anything went wrong.
 *
 * A cue delivered ten minutes late is actively harmful: the device cannot
 * tell a stale one from a fresh one, so it would start the camera, take
 * the sound card, block the chime, and give up on idle_timeout because
 * nobody came. Freshness has to be decided here, where the clock is.
 */
const WATCH_INTENT_TTL_MS = 30_000;

// Identifies one viewer to the device, per the viewer-requested frame in
// docs/server-brief.md. Process-local and never persisted - it names a
// connection, not a person.
let nextPeerId = 1;

function send(socket, payload) {
  if (socket.readyState !== socket.OPEN) return false;
  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch (err) {
    // A socket that died between the readyState check and the write.
    // Nothing useful to do, and the close handler will clean up.
    return false;
  }
}

/**
 * Writes presence - and, on connecting, the contact timestamp with it.
 *
 * Going offline still writes only on a transition. The `$ne` filter is
 * what makes that cheap: a doorbell on a poor connection would otherwise
 * write to the database every few seconds to say what it already said.
 *
 * Connecting cannot use the same filter, and this is the subtle half.
 * `requireDevice` writes `lastContactAt` on every HTTP call a doorbell
 * makes, but the signaling hello never did - so a device could hold a
 * socket for a week with nothing happening at its door and report a
 * timestamp a week old. Worse, a device's *first* contact over the socket
 * left `lastContactAt` null, and null is exactly what makes the app say
 * "never connected" - about a doorbell that is connected right now.
 *
 * The case the timestamp is most wanted from is a reconnect where
 * `connected` was already true (the old socket's close has not landed
 * yet), which is precisely the case `$ne` turns into a no-op. So the
 * filter loosens for connect. It is one write per device connection, not
 * one per frame.
 */
async function setConnected(device, value) {
  try {
    await Device.updateOne(
      value ? { _id: device._id } : { _id: device._id, connected: { $ne: value } },
      { $set: { connected: value, ...(value ? { lastContactAt: new Date() } : {}) } }
    );
  } catch (err) {
    console.error(`Could not record presence for ${device.deviceId || device._id}:`, err.message);
  }
}

function broadcastPresence(deviceKey, connected) {
  for (const socket of registry.browserSockets(deviceKey)) {
    send(socket, { type: 'presence', connected });
  }
}

/**
 * Tells the doorbell somebody wants to watch: stop recording and bring
 * up the call. Exported because the live-view endpoint is the natural
 * place to trigger it - a viewer who has asked for a token is a viewer
 * who is about to join, whether or not their browser socket is up.
 *
 * Returns false when the doorbell is not connected, so the caller can
 * say so rather than leaving someone watching a black rectangle.
 */
export function requestViewer(deviceKey, peer) {
  const target = registry.deviceSocket(deviceKey);
  if (!target) return false;
  return send(target, { type: 'viewer-requested', peer });
}

/**
 * Somebody pressed Watch while the doorbell was not connected.
 *
 * One entry per doorbell, replayed once when it says hello, thrown away
 * after WATCH_INTENT_TTL_MS. Without it, a viewer who asks eight seconds
 * before the bridge reconnects - the common case, because the backoff
 * starts at a second or two - sits in front of a LiveKit room the device
 * was never told to join, and the only way out is pressing Watch again.
 *
 * Two things make replaying safe. `viewer-requested` is idempotent on the
 * device: a second one while a call is already running is a no-op. And an
 * intent that expires costs nothing - the call simply never starts, which
 * is exactly what happens today.
 *
 * A Map with one entry per doorbell rather than a queue, deliberately.
 * Three people pressing Watch during an outage want one call between
 * them, not three cues; the last one wins because it is the freshest.
 */
const pendingWatch = new Map(); // deviceKey -> { peer, at }

/**
 * Exported because the socket is not the entry point that matters.
 * `handleWatch` is the `watch` frame, but the app actually calls
 * mediaController's live endpoint, and that is where the intent is
 * usually recorded - see the `deviceOnline: false` branch there.
 */
export function noteWatchIntent(deviceKey, peer) {
  const now = Date.now();

  // Swept on write, because an intent is only ever consumed by a hello and
  // a doorbell that never comes back never sends one. The map is capped at
  // one entry per device either way, so this is not a leak that grows with
  // traffic - but across a large fleet it is a pile of dead entries that
  // nothing else would ever remove, and clearing them costs a walk of a
  // map that this same walk keeps small.
  if (++intentWrites % INTENT_SWEEP_EVERY === 0) {
    for (const [key, entry] of pendingWatch) {
      if (now - entry.at >= WATCH_INTENT_TTL_MS) pendingWatch.delete(key);
    }
  }

  pendingWatch.set(deviceKey, { peer, at: now });
}

const INTENT_SWEEP_EVERY = 200;
let intentWrites = 0;

/**
 * Called once per device hello. Deletes unconditionally, whether or not
 * the intent was still fresh: a stale one must not survive to be replayed
 * against the *next* reconnect, by which time it is minutes old.
 */
function replayWatchIntent(deviceKey) {
  const waiting = pendingWatch.get(deviceKey);
  if (!waiting) return;
  pendingWatch.delete(deviceKey);

  if (Date.now() - waiting.at >= WATCH_INTENT_TTL_MS) return;
  requestViewer(deviceKey, waiting.peer);
}

/**
 * Shuts the door on hardware whose Device record has been deleted.
 *
 * The one refusal in this system that is genuinely permanent, so the one
 * place 4002 is the right answer to send unprompted. Without it the
 * doorbell keeps a socket open to a server that will 401 its every HTTP
 * call and never tell it why: no fault LED, no reconnect, nothing in any
 * log at the house.
 */
export function disconnectHardware(deviceKey, reason = 'Device removed') {
  for (const socket of registry.hardwareSockets(deviceKey)) {
    send(socket, { type: 'hello-error', error: reason });
    socket.close(CLOSE_UNAUTHORIZED, reason);
  }
  pendingWatch.delete(deviceKey);
}

/**
 * A restart means nothing is connected, whatever the database last
 * recorded. Without this, every doorbell that was online when the process
 * died shows as connected forever - the sockets are gone and no close
 * handler ever ran to say so.
 *
 * Single-process assumption, and worth naming: with two app servers this
 * would need presence keyed per instance, because one booting would wipe
 * the other's live connections.
 */
export async function resetPresence() {
  try {
    const res = await Device.updateMany({ connected: true }, { $set: { connected: false } });
    if (res.modifiedCount > 0) console.log(`Presence reset for ${res.modifiedCount} device(s)`);
  } catch (err) {
    console.error('Could not reset presence:', err.message);
  }
}

export function attachSignaling(server) {
  const wss = new WebSocketServer({ server, path: '/signal' });

  wss.on('connection', (socket) => {
    socket.ctx = null;
    socket.missedPings = 0;
    socket.on('pong', () => {
      socket.missedPings = 0;
    });

    const helloTimer = setTimeout(() => {
      if (!socket.ctx) socket.close(CLOSE_NO_HELLO, 'No hello');
    }, HELLO_TIMEOUT_MS);

    socket.on('message', async (raw) => {
      let frame;
      try {
        frame = JSON.parse(raw.toString());
      } catch (err) {
        return; // Not JSON. Nothing to answer and nothing to say.
      }
      if (!frame || typeof frame.type !== 'string') return;

      if (!socket.ctx) {
        if (frame.type !== 'hello') return;
        clearTimeout(helloTimer);
        await handleHello(socket, frame);
        return;
      }

      await routeFrame(socket, frame);
    });

    socket.on('close', () => {
      clearTimeout(helloTimer);
      handleClose(socket);
    });

    // Without a listener, an ECONNRESET on a socket is an unhandled
    // 'error' event, which in Node takes the process down with it.
    socket.on('error', (err) => {
      console.error('Signaling socket error:', err.message);
    });
  });

  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (socket.missedPings >= MISSED_PINGS_BEFORE_TERMINATE) {
        // terminate, not close: a peer that has stopped answering pings
        // will not complete a closing handshake either.
        socket.terminate();
        continue;
      }
      // Counted up before the ping, not reset by it. A pong clears this
      // back to zero, so the count is "pings sent since the last answer"
      // - which is the thing being tolerated.
      socket.missedPings++;
      socket.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);

  // Node keeps the process alive for a pending timer, so an interval that
  // runs forever would stop the server from ever shutting down cleanly.
  heartbeat.unref();
  wss.on('close', () => clearInterval(heartbeat));

  eventBus.on(EVENT_INGESTED, ({ device, event }) => {
    // This runs inside ingestEvent's call stack, so a throw here would
    // fail the ingest that succeeded - and an alert that was stored but
    // unacknowledged gets sent again forever. Push is strictly
    // best-effort; storing was the job that mattered.
    try {
      const payload = { type: 'event', event: event.toJSON() };
      for (const socket of registry.browserSockets(String(device._id))) send(socket, payload);
    } catch (err) {
      console.error('Live event push failed:', err.message);
    }
  });

  // A clip landing for an alert already on someone's screen. Keyed by the
  // device's eventId, which is what the activity list matches clips on.
  eventBus.on(CLIP_STORED, ({ device, eventId, clip }) => {
    try {
      const payload = { type: 'clip', eventId, clip };
      for (const socket of registry.browserSockets(String(device._id))) send(socket, payload);
    } catch (err) {
      console.error('Clip-ready push failed:', err.message);
    }
  });

  // Who holds the microphone, pushed to everyone watching so the UI can
  // show it rather than each viewer guessing from whether they hear
  // themselves.
  talkFloorBus.on(TALK_FLOOR_CHANGED, ({ deviceKey, userId }) => {
    try {
      const payload = { type: 'talk-floor', userId };
      for (const socket of registry.browserSockets(deviceKey)) send(socket, payload);
    } catch (err) {
      console.error('Talk floor broadcast failed:', err.message);
    }
  });

  // Who is recording - pushed so everyone else's Rec button says so, and
  // frees up the moment they stop.
  recordingFloorBus.on(RECORDING_FLOOR_CHANGED, ({ deviceKey, recorder }) => {
    try {
      const payload = { type: 'record-floor', recorder };
      for (const socket of registry.browserSockets(deviceKey)) send(socket, payload);
    } catch (err) {
      console.error('Recording floor broadcast failed:', err.message);
    }
  });

  console.log('Signaling attached at /signal');
  return wss;
}

async function handleHello(socket, frame) {
  let result;
  try {
    result = await authenticate(frame);
  } catch (err) {
    // The connection-level form of rule 3. A database blip is not a
    // rejection, and answering as if it were would tell a doorbell its
    // credential is bad. 1013 "try again later" says the opposite of
    // CLOSE_UNAUTHORIZED, which is exactly the distinction that matters.
    console.error('Signaling authentication failed transiently:', err.message);
    socket.close(1013, 'Try again later');
    return;
  }

  if (result.error) {
    send(socket, { type: 'hello-error', error: result.error });

    /**
     * WHICH CLOSE CODE, AND WHY IT IS A DECISION RATHER THAN A CONSTANT.
     *
     * 4002 means *permanent* to a doorbell. It stops reconnecting for the
     * lifetime of the process, lights the fault pattern on the LED, and
     * waits for a human. So every refusal sent as 4002 is a refusal that
     * requires somebody to walk up to the unit.
     *
     * That is correct for the refusals that exist today - a credential
     * that has been re-minted, a Device record that has been deleted -
     * because no amount of retrying will ever turn those into a yes, and
     * a doorbell hammering a server forever is worse than a dark LED.
     *
     * It stops being correct the first time a refusal is temporary, and
     * the shape of that mistake is specific: a feature like "pause this
     * doorbell" or "disable this device", refused here as 4002, is an
     * unpausable pause. The unit goes dark and stays dark until somebody
     * restarts it on site - a software state turned into a site visit.
     *
     * So authenticate() marks a refusal `retryable` when waiting could
     * fix it, and that becomes 1013. Rate limiting, a maintenance window,
     * a deploy: 1013, or a thrown error, never 4002. Nothing produces a
     * retryable refusal yet; the branch exists so that adding the first
     * one is a decision somebody makes rather than a default they inherit.
     */
    socket.close(
      result.retryable ? CLOSE_TRY_LATER : CLOSE_UNAUTHORIZED,
      result.retryable ? 'Try again later' : 'Unauthorized'
    );
    return;
  }

  const { device } = result;
  const deviceKey = String(device._id);
  const role = frame.role;

  socket.ctx = {
    role,
    device,
    deviceKey,
    userId: result.userId || null,
    peerId: role === ROLE_BROWSER ? nextPeerId++ : null
  };

  const displaced = registry.add(deviceKey, role, socket);
  if (displaced) {
    // Told why, rather than just dropped. A daemon that sees this knows
    // it was superseded and should not reconnect in a loop fighting its
    // own replacement.
    send(displaced, { type: 'replaced' });
    displaced.close(CLOSE_REPLACED, 'Replaced by a newer connection');
  }

  send(socket, {
    type: 'hello-ok',
    role,
    deviceId: device.deviceId || null,
    device: deviceKey,
    peer: socket.ctx.peerId,
    // So a browser renders the right state immediately instead of
    // assuming offline until the next transition.
    connected: registry.isDeviceOnline(deviceKey),
    // Who is recording, for the same reason: a viewer arriving mid-recording
    // should see the button taken, not find out by pressing it.
    ...(role === ROLE_BROWSER && { recorder: whoIsRecording(deviceKey) })
  });

  if (role === ROLE_DEVICE) {
    await setConnected(device, true);
    broadcastPresence(deviceKey, true);
    // Last, and after presence: a viewer's browser should have the
    // doorbell showing as connected before the call it asked for
    // arrives, not after.
    replayWatchIntent(deviceKey);
  }
}

async function routeFrame(socket, frame) {
  const { role } = socket.ctx;

  switch (frame.type) {
    case 'event':
      // Only the daemon reports events. The media script has no sensors
      // and a browser has no business inventing doorbell presses.
      if (role !== ROLE_DEVICE) return;
      return handleEvent(socket, frame);

    case 'watch':
      if (role !== ROLE_BROWSER) return;
      return handleWatch(socket);

    case 'ping':
      return void send(socket, { type: 'pong' });

    default:
      return; // Unknown frames are ignored, not answered.
  }
}

async function handleEvent(socket, frame) {
  const { device } = socket.ctx;
  const { eventId, kind, at, meta } = frame;

  let result;
  try {
    result = await ingestEvent({ device, eventId, kind, at, meta });
  } catch (err) {
    // RULE 3, and the single most consequential line in this file.
    //
    // Send nothing. Not an ack, not an error frame, not a close. An
    // unacknowledged alert is one the device keeps retrying, which is
    // exactly what should happen when the failure was ours and
    // temporary. Answering `ok: false` here would make the doorbell
    // discard a real visitor permanently because our database hiccuped.
    console.error(`Ingest failed for event ${eventId} (no ack sent):`, err.message);
    return;
  }

  if (result.outcome === REJECTED) {
    // Permanent, and the device is meant to drop it. Only reached for
    // things that will still be wrong next time - an unknown kind, an
    // unparseable timestamp.
    send(socket, { type: 'event-ack', eventId, kind, ok: false, error: result.reason });
    return;
  }

  // Acknowledges the kind that was *sent*, not the kind now stored. The
  // device dedupes its own outbox by (eventId, kind), so a motion
  // acknowledged as "ring" because a later press upgraded the record
  // would leave the motion looking unsent forever.
  send(socket, { type: 'event-ack', eventId, kind, ok: true });
}

function handleWatch(socket) {
  const { deviceKey, peerId } = socket.ctx;
  const target = registry.deviceSocket(deviceKey);

  if (!target) {
    // Held, not just refused. The answer stays honest - the doorbell is
    // not connected *right now* - but a reconnect inside the next thirty
    // seconds now starts the call instead of needing the button pressed
    // again.
    noteWatchIntent(deviceKey, peerId);
    send(socket, { type: 'watch-error', error: 'That doorbell is not connected right now' });
    return;
  }

  // The device stops any recording first, then hands the call to the
  // media script. Deliberately not an offer: with LiveKit there is no SDP
  // on this socket in either direction, and this frame stays a cue.
  send(target, { type: 'viewer-requested', peer: peerId });
  send(socket, { type: 'watch-requested', peer: peerId });
}

function handleClose(socket) {
  const ctx = socket.ctx;
  if (!ctx) return;

  const { role, deviceKey, device, userId } = ctx;
  const removed = registry.remove(deviceKey, role, socket);

  // A viewer whose socket drops has stopped talking whether they said so
  // or not - closing the tab mid-sentence is the ordinary way a turn
  // ends. Without this the floor would sit held until someone else
  // pressed the button.
  if (role === ROLE_BROWSER && removed) {
    releaseIfHeld(deviceKey, userId);
    // The same for a recording: a closed tab has stopped recording.
    releaseRecordingIfHeld(deviceKey, userId && String(userId));
  }

  // `removed` is false when this socket had already been displaced by a
  // newer one. Skipping the presence write in that case is what stops a
  // reconnect from being reported as a disconnect: the old socket's close
  // arrives *after* the new one registered, and marking the doorbell
  // offline there would be wrong and would flap the UI.
  if (role === ROLE_DEVICE && removed && !registry.isDeviceOnline(deviceKey)) {
    setConnected(device, false);
    broadcastPresence(deviceKey, false);

    // The call is over from the doorbell's side whether or not the
    // viewers know yet - webrtc-video.py exits when the room empties or
    // when it cannot rejoin, and the daemon learns that from a pidfd, not
    // from us. So the floor goes with it. Without this a device dropping
    // mid-call left the microphone held by whoever had it, through the
    // whole reconnect and long after there was anybody to talk to.
    releaseWhoeverHolds(deviceKey);
  }
}
