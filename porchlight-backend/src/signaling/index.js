import { WebSocketServer } from 'ws';
import { Device } from '../models/Device.js';
import { ingestEvent, REJECTED } from '../services/events/ingestEvent.js';
import { eventBus, EVENT_INGESTED } from '../services/events/eventBus.js';
import { authenticate } from './authenticate.js';
import { talkFloorBus, TALK_FLOOR_CHANGED, releaseIfHeld } from '../services/media/talkFloor.js';
import * as registry from './registry.js';
import {
  ROLE_DEVICE,
  ROLE_BROWSER,
  CLOSE_REPLACED,
  CLOSE_UNAUTHORIZED,
  CLOSE_NO_HELLO
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
 * Writes presence, but only on an actual transition.
 *
 * The `$ne` in the filter is what makes this cheap: a doorbell on a poor
 * connection reconnecting every few seconds would otherwise write to the
 * database every few seconds to say what it already said.
 */
async function setConnected(device, value) {
  try {
    await Device.updateOne({ _id: device._id, connected: { $ne: value } }, { $set: { connected: value } });
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
    socket.isAlive = true;
    socket.on('pong', () => {
      socket.isAlive = true;
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
      if (!socket.isAlive) {
        // terminate, not close: a peer that has stopped answering pings
        // will not complete a closing handshake either.
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
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
    socket.close(CLOSE_UNAUTHORIZED, 'Unauthorized');
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
    connected: registry.isDeviceOnline(deviceKey)
  });

  if (role === ROLE_DEVICE) {
    await setConnected(device, true);
    broadcastPresence(deviceKey, true);
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
  if (role === ROLE_BROWSER && removed) releaseIfHeld(deviceKey, userId);

  // `removed` is false when this socket had already been displaced by a
  // newer one. Skipping the presence write in that case is what stops a
  // reconnect from being reported as a disconnect: the old socket's close
  // arrives *after* the new one registered, and marking the doorbell
  // offline there would be wrong and would flap the UI.
  if (role === ROLE_DEVICE && removed && !registry.isDeviceOnline(deviceKey)) {
    setConnected(device, false);
    broadcastPresence(deviceKey, false);
  }
}
