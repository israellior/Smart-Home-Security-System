import { EventEmitter } from 'node:events';

/**
 * Who is recording a doorbell's live view right now. One at a time.
 *
 * The opposite rule to the talk floor, on purpose. Talk is last press
 * wins, because being cut off mid-sentence costs a sentence. Taking this
 * one from somebody would cut their recording short and leave two partial
 * clips of one visit, so here the first press holds it and everyone else
 * is told who has it until they stop.
 *
 * It is coordination between people who share a doorbell, not access
 * control. The recording happens in the holder's own browser, which could
 * record the screen without asking anyone; what this guarantees is that
 * the app never offers two people the button at once, and that everybody
 * watching can see who pressed it.
 *
 * In memory, like the talk floor and presence, for the same reason - see
 * the note on presence in signaling/index.js.
 */

export const recordingFloorBus = new EventEmitter();
export const RECORDING_FLOOR_CHANGED = 'recording:floor';

// The browser stops at five minutes on its own. Past that, a holder that
// never released has gone - a laptop lid, a crashed tab - and nobody else
// should have to wait on it. The slack covers a release that is slow to
// arrive over a bad connection.
const FLOOR_TTL_MS = 5 * 60 * 1000 + 30_000;

const floors = new Map(); // deviceKey -> { userId, name, since, timer }

function announce(deviceKey) {
  recordingFloorBus.emit(RECORDING_FLOOR_CHANGED, { deviceKey, recorder: whoIsRecording(deviceKey) });
}

/** `{ userId, name }` of whoever is recording, or null. */
export function whoIsRecording(deviceKey) {
  const held = floors.get(deviceKey);
  return held ? { userId: held.userId, name: held.name } : null;
}

/**
 * Take the floor if it is free. Returns `{ taken, recorder }` - `recorder`
 * being whoever holds it afterwards, which is the caller when `taken`.
 *
 * Asking again while already holding it is a yes, so a retried request
 * whose first answer was lost does not lock its own sender out.
 */
export function takeRecordingFloor(deviceKey, userId, name) {
  const held = floors.get(deviceKey);
  if (held && held.userId !== userId) return { taken: false, recorder: whoIsRecording(deviceKey) };

  if (held) clearTimeout(held.timer);
  floors.set(deviceKey, {
    userId,
    name,
    since: new Date(),
    timer: setTimeout(() => releaseRecordingFloor(deviceKey, userId), FLOOR_TTL_MS)
  });

  if (!held) announce(deviceKey);
  return { taken: true, recorder: whoIsRecording(deviceKey) };
}

/** Only the holder can release, so a stale release cannot free someone else's. */
export function releaseRecordingFloor(deviceKey, userId) {
  const held = floors.get(deviceKey);
  if (!held || held.userId !== userId) return false;

  clearTimeout(held.timer);
  floors.delete(deviceKey);
  announce(deviceKey);
  return true;
}

/**
 * The holder's socket dropped. A closed tab has stopped recording whether
 * it said so or not.
 *
 * A socket that merely blipped also lands here, which frees the floor
 * while that browser goes on recording. The cost is that someone else
 * could start a second recording in that window - two clips of one visit,
 * both kept. The alternative, holding on through a drop, costs everyone a
 * five-minute wait every time somebody closes a tab mid-recording, which
 * is the far commoner event.
 */
export function releaseRecordingIfHeld(deviceKey, userId) {
  if (userId) releaseRecordingFloor(deviceKey, userId);
}
