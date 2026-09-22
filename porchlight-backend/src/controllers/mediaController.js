import { mediaConfigured, mintMediaToken } from '../config/media.js';
import { takeFloor, releaseFloor, whoIsTalking } from '../services/media/talkFloor.js';
import { requestViewer } from '../signaling/index.js';
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
  if (online) requestViewer(deviceKey, req.userId);

  return res.json({
    ...grant,
    // So the UI can say "your doorbell is offline" instead of showing a
    // black rectangle and letting the viewer conclude it is broken.
    deviceOnline: online,
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
 */
export async function takeTalk(req, res) {
  if (!mediaConfigured) return unavailable(res);
  const { device } = req;
  if (!device.deviceId) {
    return res.status(409).json({ error: 'No hardware is provisioned for this doorbell yet' });
  }

  const result = await takeFloor(String(device._id), device.deviceId, req.userId);
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
