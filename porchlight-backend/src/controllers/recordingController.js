import { randomUUID } from 'node:crypto';
import { Clip } from '../models/Clip.js';
import { Event, RANK_BY_KIND } from '../models/Event.js';
import { User } from '../models/User.js';
import { eventBus, EVENT_INGESTED, CLIP_STORED } from '../services/events/eventBus.js';
import { consume } from '../utils/rateLimit.js';
import { takeRecordingFloor, releaseRecordingFloor } from '../services/media/recordingFloor.js';
import {
  storageConfigured,
  signUpload,
  uploadedSize,
  storedSize,
  promoteUpload
} from '../config/storage.js';

/**
 * Recordings made from the live view, by a member rather than the doorbell.
 *
 * The doorbell cannot make these. While a viewer is watching, its camera
 * belongs to the call, and a second H.264 encode alongside the one already
 * feeding LiveKit is more than the Pi has to give. The viewer's browser,
 * on the other hand, already holds the decoded picture, the doorbell's
 * sound and - while they talk - their own microphone, so it records and
 * uploads, and this server does what it does for the doorbell's clips:
 * hand out a grant for one object, then check what arrived.
 *
 *   1. POST /devices/:id/recordings              -> eventId + a PUT grant
 *   2. PUT  <that url>                           -> straight to the bucket
 *   3. POST /devices/:id/recordings/:eventId/confirm
 *
 * Unlike a doorbell's clip, the recording is finished before step 1, so
 * the grant is for its exact size and nothing larger can be put through
 * it. And the event is made at step 3, not before: a recording appears in
 * Activity only once it is playable, so nobody is shown a "saving" row for
 * an upload that a closed tab abandoned.
 *
 * Every member sees every recording, which is the point of putting them in
 * Activity. Nobody is notified and no unread count moves - see
 * ALERT_KINDS.
 */

// The browser stops recording at five minutes on its own (useLiveRecording
// on the frontend). The slack covers the recorder's own clock running a
// beat past the stop.
const MAX_DURATION_MS = 5 * 60 * 1000 + 5_000;

// Five minutes at the bitrate the browser asks for is about 40MB. The cap
// sits well above that, because a recorder's bitrate is a request rather
// than a promise, and well below anything that would be a problem to hold.
const MAX_BYTES = 100 * 1024 * 1024;

// Per member, across doorbells. Far beyond anyone pressing Record by hand,
// and a ceiling on a script that is not.
const GRANT_LIMIT = { limit: 30, windowMs: 60 * 60 * 1000 };

const MAX_EVENT_ID = 128;

function unavailable(res) {
  return res.status(503).json({ error: 'Recording storage is not configured on this server' });
}

/**
 * Before any of that: asking to be the one recording. Any member may, one
 * at a time - see services/media/recordingFloor.js. The browser does not
 * start its recorder until this says yes, and releases the moment it
 * stops, before the upload, so the next person can start while the last
 * recording is still on its way to the bucket.
 *
 * 409 with the holder's name, so the button can say who has it.
 */
export async function takeRecordingTurn(req, res) {
  const deviceKey = String(req.device._id);
  const me = await User.findById(req.userId, { name: 1 });
  const { taken, recorder } = takeRecordingFloor(deviceKey, String(req.userId), me?.name ?? null);

  if (!taken) {
    return res.status(409).json({
      error: `${recorder.name || 'Someone else'} is already recording`,
      recorder
    });
  }
  return res.json({ recorder });
}

export async function releaseRecordingTurn(req, res) {
  const released = releaseRecordingFloor(String(req.device._id), String(req.userId));
  return res.json({ released });
}

/** Step 1: an eventId of our own, and a grant to upload exactly `bytes`. */
export async function createRecording(req, res) {
  if (!storageConfigured) return unavailable(res);

  const { device } = req;
  if (!device.deviceId) {
    return res.status(409).json({ error: 'No hardware is provisioned for this doorbell yet' });
  }

  const { bytes, durationMs } = req.body || {};
  if (!Number.isInteger(bytes) || bytes <= 0) {
    return res.status(400).json({ error: '`bytes` must be a positive integer' });
  }
  if (bytes > MAX_BYTES) {
    return res.status(413).json({ error: 'That recording is too large to save' });
  }
  if (typeof durationMs !== 'number' || !(durationMs > 0) || durationMs > MAX_DURATION_MS) {
    return res.status(400).json({ error: '`durationMs` is missing or out of range' });
  }

  const allowance = consume('recording:grant', String(req.userId), GRANT_LIMIT);
  if (!allowance.allowed) {
    res.set('Retry-After', String(Math.ceil(allowance.retryAfterMs / 1000)));
    return res.status(429).json({ error: 'Too many recordings at once. Try again shortly.' });
  }

  // Minted here, never accepted from the browser, so a recording cannot be
  // aimed at a doorbell's eventId - and through it at the upgrade rule or
  // at someone else's clip.
  const eventId = randomUUID();

  // The declared size and length are stored now and checked at step 3.
  // `bytes` is also already bound into the signature, so the check there
  // is a backstop, not the limit.
  await Clip.create({
    device: device._id,
    eventId,
    status: 'pending',
    recordedBy: req.userId,
    bytes,
    durationMs
  });

  const grant = await signUpload(device.deviceId, eventId, { bytes });
  return res.status(201).json({ eventId, ...grant });
}

/**
 * Step 3: the bytes are there, so the recording goes into Activity.
 *
 * Idempotent, as the doorbell's confirm is, and for a sharper reason: the
 * database behind this drops writes in bursts, and a member whose confirm
 * failed retries it. Every step below is safe to repeat, and they run in
 * the order that leaves nothing half-shown if one fails - the object is
 * promoted and the clip marked playable before the event exists, so the
 * event appearing is the last thing that happens.
 */
export async function confirmRecording(req, res) {
  if (!storageConfigured) return unavailable(res);

  const { device } = req;
  const { eventId } = req.params;
  if (typeof eventId !== 'string' || eventId.length === 0 || eventId.length > MAX_EVENT_ID) {
    return res.status(400).json({ error: 'eventId must be a non-empty string' });
  }

  // `recordedBy` in the filter is the authorization. Membership got the
  // caller this far; this limits them to the grant they were given.
  const clip = await Clip.findOne({ device: device._id, eventId, recordedBy: req.userId });
  if (!clip) return res.status(404).json({ error: 'No recording was started with that id' });

  const pendingBytes = await uploadedSize(device.deviceId, eventId);
  const actualBytes = pendingBytes ?? (await storedSize(device.deviceId, eventId));

  if (actualBytes === null) {
    return res.status(409).json({ error: 'The recording has not finished uploading' });
  }
  if (actualBytes !== clip.bytes) {
    return res.status(409).json({
      error: `Uploaded ${actualBytes} bytes but the recording is ${clip.bytes} - upload again`
    });
  }

  if (pendingBytes !== null) await promoteUpload(device.deviceId, eventId);

  const stored = await Clip.findOneAndUpdate(
    { _id: clip._id },
    { $set: { status: 'stored', bytes: actualBytes, confirmedAt: clip.confirmedAt ?? new Date() } },
    { new: true }
  );

  // Server time throughout. The grant was asked for the moment recording
  // stopped, so its time less the duration is when it started - without
  // trusting the clock of whichever phone did the recording.
  const at = new Date(clip.createdAt.getTime() - (clip.durationMs || 0));

  // A snapshot of the name, so the row still says who recorded it after
  // they leave the doorbell or their account is gone.
  const recorder = await User.findById(req.userId, { name: 1 });

  const event = await Event.findOneAndUpdate(
    { device: device._id, eventId },
    {
      $setOnInsert: {
        kindRank: RANK_BY_KIND.live,
        at,
        receivedAt: new Date(),
        meta: { recordedBy: { id: String(req.userId), name: recorder?.name ?? null } }
      }
    },
    { upsert: true, new: true }
  );

  const clipInfo = { durationMs: stored.durationMs, partial: stored.partial, bytes: stored.bytes };

  // Onto the screens of everyone with Activity open, the same two frames a
  // doorbell's alert and its clip produce. Not through ingestEvent, which
  // is where notifications are sent from: nobody is told about this, it
  // just appears. Best-effort, like every push - the recording is saved
  // whether or not anyone was listening.
  try {
    eventBus.emit(EVENT_INGESTED, { device, event });
    eventBus.emit(CLIP_STORED, { device, eventId, clip: clipInfo });
  } catch (err) {
    console.error(`Recording push failed for ${eventId}:`, err.message);
  }

  return res.json({ event: { ...event.toJSON(), clip: clipInfo } });
}
