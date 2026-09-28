import { EventEmitter } from 'node:events';
import { setCanTalk } from '../../config/media.js';

/**
 * Who is allowed to speak into a doorbell right now.
 *
 * Push-to-talk, last press wins: holding the button takes the floor from
 * whoever had it, releasing gives it up. 1-5 viewers, typically one
 * talking - a queue would be machinery for a situation that does not
 * arise, and being cut off mid-sentence is self-regulating among people
 * who know each other.
 *
 * Permissions are changed on the live LiveKit session rather than by
 * issuing a new token, so pressing the button does not tear down and
 * rebuild the connection. A token swap would mean a second of dead air
 * every time somebody spoke.
 *
 * In memory, like presence, and for the same reason: it describes
 * sockets this process is holding. Two app servers would need this
 * keyed per instance - see the note on presence in signaling/index.js.
 */

// Signaling listens here. An emitter rather than a direct call because
// signaling already imports this module to release a floor when a viewer
// disconnects, and importing back the other way would be a cycle.
export const talkFloorBus = new EventEmitter();
export const TALK_FLOOR_CHANGED = 'talk:floor';

// A viewer who closes their laptop mid-turn stops sending audio but
// never tells us. Without an expiry their floor would be held until
// somebody else pressed the button - the stuck-floor failure the
// explicit request-and-release model has and this one should not.
const FLOOR_TTL_MS = 60 * 1000;

const floors = new Map(); // deviceKey -> { userId, deviceId, since, timer }

function clear(deviceKey) {
  const held = floors.get(deviceKey);
  if (held?.timer) clearTimeout(held.timer);
  floors.delete(deviceKey);
}

function announce(deviceKey, userId) {
  talkFloorBus.emit(TALK_FLOOR_CHANGED, { deviceKey, userId });
}

export function whoIsTalking(deviceKey) {
  return floors.get(deviceKey)?.userId || null;
}

/**
 * Take the floor. Whoever held it loses it.
 *
 * The revoke runs before the grant, so there is never an instant where
 * two microphones are live - a doorbell with two people talking into it
 * at once is worse than a moment of silence during the handover.
 */
export async function takeFloor(deviceKey, deviceId, userId) {
  const held = floors.get(deviceKey);

  if (held && held.userId === userId) {
    // Re-pressing while already holding it just extends the turn.
    clearTimeout(held.timer);
    held.timer = setTimeout(() => releaseFloor(deviceKey, userId), FLOOR_TTL_MS);
    return { userId, alreadyHeld: true };
  }

  if (held) await setCanTalk(deviceId, held.userId, false);
  clear(deviceKey);

  // Throws if the grant did not land, which leaves the floor held by
  // nobody - the previous holder has already been revoked and this one
  // never gets recorded. That is the right place to fail: an empty floor
  // is one the next press can take, whereas recording this viewer as the
  // holder would have blocked everyone else for the full TTL while the
  // one person "holding" it had no microphone.
  await setCanTalk(deviceId, userId, true);
  floors.set(deviceKey, {
    userId,
    deviceId,
    since: new Date(),
    timer: setTimeout(() => releaseFloor(deviceKey, userId), FLOOR_TTL_MS)
  });

  announce(deviceKey, userId);
  return { userId, alreadyHeld: false };
}

/**
 * Give it up. Only the holder can, so a stale release from someone who
 * was cut off cannot silence whoever took it from them.
 */
export async function releaseFloor(deviceKey, userId) {
  const held = floors.get(deviceKey);
  if (!held || held.userId !== userId) return false;

  clear(deviceKey);
  await setCanTalk(held.deviceId, userId, false);
  announce(deviceKey, null);
  return true;
}

/** Called when a viewer's socket drops - the common way a turn ends. */
export function releaseIfHeld(deviceKey, userId) {
  if (!userId) return;
  if (floors.get(deviceKey)?.userId !== userId) return;
  releaseFloor(deviceKey, userId).catch((err) => {
    console.error(`Could not release talk floor for ${userId}:`, err.message);
  });
}

/**
 * Drops the floor whoever is holding it, because the call itself is over.
 *
 * Called when the *doorbell* goes, which is the other way a turn ends and
 * the one that used to leak. A viewer closing a tab releases their own
 * floor through releaseIfHeld; a doorbell dropping mid-call released
 * nothing, so the floor stayed held by whoever had it - through the
 * device's whole reconnect and long after the call was over, blocking
 * everyone else for the full TTL.
 *
 * Separate from releaseIfHeld because the caller genuinely does not know
 * or care who was talking: there is nobody left to talk to. Naming a user
 * id just to satisfy the signature is how the two callers would end up
 * looking like they were doing the same thing.
 */
export function releaseWhoeverHolds(deviceKey) {
  const held = floors.get(deviceKey);
  if (!held) return;
  releaseFloor(deviceKey, held.userId).catch((err) => {
    console.error(`Could not release talk floor on ${deviceKey}:`, err.message);
  });
}
