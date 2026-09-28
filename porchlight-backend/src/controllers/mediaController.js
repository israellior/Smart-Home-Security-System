import { mediaConfigured, mintMediaToken, publisherIdentity } from '../config/media.js';
import { takeFloor, releaseFloor, whoIsTalking } from '../services/media/talkFloor.js';
import { requestViewer, noteWatchIntent } from '../signaling/index.js';
import { isDeviceOnline } from '../signaling/registry.js';

/**
 * Live video and two-way talk.
 *
 * This server mints tokens and decides who may speak. It carries no
 * media: the Pi publishes one stream to LiveKit and LiveKit copies it
 * out, with both ends connecting outward so no home router has to accept
 * an incoming connection.
 */

function unavailable(res) {
  return res.status(503).json({ error: 'Live video is not configured on this server' });
}

/**
 * The doorbell's own two tokens, fetched with its credential. No user is
 * involved.
 *
 * Two endpoints rather than one with a `role` parameter, deliberately: a
 * parameter is a thing that can be passed wrong, and these two have
 * deliberately different rights. There is no path through the publisher
 * endpoint that mints a subscriber.
 */
/**
 * No presence check on either of these, and that is deliberate - leave it
 * that way.
 *
 * The media script has no signaling socket to us and never did. A call can
 * be running, and reconnecting to LiveKit with a fresh token per attempt,
 * during a window where the daemon's socket is down and isDeviceOnline is
 * false. A presence check here would turn a recoverable wobble into a dead
 * call.
 *
 * Which also makes these the only device-authenticated traffic during a
 * reconnect, so they are where a clock problem shows up first: every token
 * carries nbf = mint time, and a server clock a minute ahead of LiveKit's
 * makes every one of them not-yet-valid with every endpoint still
 * returning 200. See checkClockSkew in config/media.js.
 */
export async function getPublisherToken(req, res) {
  if (!mediaConfigured) return unavailable(res);
  return res.json(await mintMediaToken('publisher', { deviceId: req.hardware.deviceId }));
}

export async function getListenerToken(req, res) {
  if (!mediaConfigured) return unavailable(res);
  return res.json(await mintMediaToken('listener', { deviceId: req.hardware.deviceId }));
}

/**
 * A person's token to watch. Behind requireDeviceAccess, so membership
 * is already proven - this can only ever mint for a doorbell the caller
 * belongs to.
 *
 * That check plus a two-minute token is what makes "removing someone
 * revokes their access immediately" true: they cannot mint another, and
 * the one they hold dies on its own.
 */
export async function getViewerToken(req, res) {
  if (!mediaConfigured) return unavailable(res);

  const { device } = req;
  if (!device.deviceId) {
    return res.status(409).json({ error: 'No hardware is provisioned for this doorbell yet' });
  }

  const deviceKey = String(device._id);
  const grant = await mintMediaToken('viewer', { deviceId: device.deviceId, userId: req.userId });

  // Nudge the doorbell: stop recording, bring up the call. Done here
  // rather than relying on the browser's own socket, because asking for
  // a token *is* the intent to watch. The cue is one-way and the device
  // may already be in the room, so a failure to deliver it is reported,
  // not thrown.
  const online = isDeviceOnline(deviceKey);
  if (online) {
    requestViewer(deviceKey, req.userId);
  } else {
    // Held for thirty seconds and replayed when the doorbell says hello.
    // This is the entry point that matters for it: the browser's own
    // socket sends `watch` only when the live view is already open,
    // whereas asking for a token is what the app does when somebody
    // presses the button - including from a page whose socket is down.
    //
    // A doorbell whose bridge is mid-backoff is typically back in a second
    // or two, so the usual outcome of this line is a call that starts on
    // its own and a viewer who never learns anything went wrong.
    noteWatchIntent(deviceKey, req.userId);
  }

  return res.json({
    ...grant,
    // So the UI can say "your doorbell is offline" instead of showing a
    // black rectangle and letting the viewer conclude it is broken.
    deviceOnline: online,
    // What the viewer has to wait for, and the reason it is sent rather
    // than assembled in the browser.
    //
    // `deviceOnline: true` is not a promise that a call will start.
    // requestViewer reports whether the frame was written to a socket; it
    // cannot report whether anything read it, and between a doorbell
    // losing power and the heartbeat noticing there is up to thirty
    // seconds in which that write succeeds into a socket with nobody on
    // the other end. So the UI keys "live" on this participant appearing
    // or a video track arriving - never on the token it already holds.
    publisherIdentity: publisherIdentity(device.deviceId),
    talkingUserId: whoIsTalking(deviceKey)
  });
}

/**
 * Take the microphone. Push-to-talk, last press wins - whoever held it
 * loses it, with the revoke before the grant so two microphones are
 * never live at once.
 *
 * Permissions change on the session that is already up rather than
 * through a new token, so pressing the button does not cost a reconnect.
 *
 * A 200 here means the viewer really may publish now. If the grant did
 * not land this answers 502 and leaves the floor free, because the
 * browser treats success as permission to open the microphone.
 */
export async function takeTalk(req, res) {
  if (!mediaConfigured) return unavailable(res);
  const { device } = req;
  if (!device.deviceId) {
    return res.status(409).json({ error: 'No hardware is provisioned for this doorbell yet' });
  }

  let result;
  try {
    result = await takeFloor(String(device._id), device.deviceId, req.userId);
  } catch (err) {
    // Caught here rather than left to the central handler, which reports
    // every error as the same generic 500. The browser is about to try
    // to publish on the strength of this response, so it needs to be
    // told what went wrong - a talk button that fails silently is how
    // this went unnoticed in the first place.
    console.error(`Talk floor grant failed on ${device.deviceId}:`, err.message);
    return res.status(502).json({ error: err.message });
  }

  return res.json({ talkingUserId: result.userId, alreadyHeld: result.alreadyHeld });
}

export async function releaseTalk(req, res) {
  if (!mediaConfigured) return unavailable(res);

  const deviceKey = String(req.device._id);
  // Only the holder can release, so a stale release from someone who was
  // already cut off cannot silence whoever took the floor from them.
  const released = await releaseFloor(deviceKey, req.userId);
  return res.json({ released, talkingUserId: whoIsTalking(deviceKey) });
}
