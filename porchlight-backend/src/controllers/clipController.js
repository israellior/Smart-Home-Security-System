import { Clip } from '../models/Clip.js';
import { ingestEvent, REJECTED } from '../services/events/ingestEvent.js';
import {
  storageConfigured,
  signUpload,
  signPlayback,
  uploadedSize,
  storedSize,
  promoteUpload
} from '../config/storage.js';

/**
 * Clip upload, in the three steps the device already implements:
 *
 *   1. POST /api/clips/<eventId>/upload-url   -> a short-lived PUT grant
 *   2. PUT  <that url>                        -> straight to the bucket
 *   3. POST /api/clips/<eventId>/confirm      -> metadata, in the body
 *
 * The server is not in the middle of step 2 and never sees the bytes.
 *
 * **A 2xx on step 3 - not step 2 - is what lets the device delete its
 * local copy.** An object that was uploaded and never confirmed is one
 * the server does not know exists, so every non-2xx anywhere here has to
 * mean "keep your copy", and the device restarts at step 1.
 */

const MAX_EVENT_ID = 128;

function badEventId(eventId) {
  return typeof eventId !== 'string' || eventId.length === 0 || eventId.length > MAX_EVENT_ID;
}

/**
 * 503 rather than 500 when there is no bucket: it says "not right now"
 * rather than "you are wrong", which is the retryable shape. A doorbell
 * that cannot upload keeps its recording, and the clip arrives whenever
 * storage is configured.
 */
function unavailable(res) {
  return res.status(503).json({ error: 'Clip storage is not configured on this server' });
}

/**
 * Step 1. Deliberately accepts an empty body and requires nothing of it.
 *
 * The device comes from the credential and the event from the path, so
 * there is nothing left for a body to carry - and the uploader sends
 * literally `{}`. An eventId we have never seen is normal, not an error:
 * the clip may well arrive before its alert.
 */
export async function createUploadUrl(req, res) {
  if (!storageConfigured) return unavailable(res);

  const { eventId } = req.params;
  if (badEventId(eventId)) {
    return res.status(400).json({ error: 'eventId must be a non-empty string' });
  }

  const { hardware } = req;

  // Binds this eventId to the calling doorbell on first use. Idempotent,
  // so a device restarting at step 1 after a failed upload gets the same
  // binding and the same object key rather than a second one.
  const clip = await Clip.findOneAndUpdate(
    { device: hardware._id, eventId },
    { $setOnInsert: { status: 'pending' } },
    { upsert: true, new: true }
  );

  const grant = await signUpload(hardware.deviceId, eventId);
  return res.status(201).json({ ...grant, status: clip.status });
}

/**
 * Step 3. The metadata the headers used to carry, now in the body, plus
 * the moment the device is allowed to forget this clip.
 */
export async function confirmUpload(req, res) {
  if (!storageConfigured) return unavailable(res);

  const { eventId } = req.params;
  if (badEventId(eventId)) {
    return res.status(400).json({ error: 'eventId must be a non-empty string' });
  }

  const { hardware } = req;
  const { deviceId, kind, at, durationMs, partial, bytes } = req.body || {};

  // `deviceId` in the body is the device's own logging convenience and
  // carries no authority: the credential already says who is calling,
  // and this endpoint can only ever act on that doorbell.
  //
  // It used to be a 403 on mismatch. That was wrong in the expensive
  // direction - a stale label in a config file would have made every
  // confirm fail permanently, wedging uploads over a field that decides
  // nothing. Logged rather than enforced, so a genuine misconfiguration
  // is still visible without being fatal.
  if (deviceId && deviceId !== hardware.deviceId) {
    console.warn(
      `Clip confirm from ${hardware.deviceId} carried deviceId "${deviceId}" - ignoring, credential wins`
    );
  }

  // The object has to actually be there. This is also the check that
  // catches a PUT which "succeeded" without storing anything.
  //
  // Two places to look, because confirming is idempotent. A device that
  // crashed between the PUT and the confirm recovers by confirming
  // again - and by then the first confirm has already promoted the
  // object out of the pending prefix, so looking only there would tell
  // the retry that nothing was ever uploaded. That is also the path a
  // `kind` upgrade arrives on: a ring confirm following a motion confirm
  // has no new upload behind it at all.
  const pendingBytes = await uploadedSize(hardware.deviceId, eventId);
  const alreadyStored = pendingBytes === null ? await storedSize(hardware.deviceId, eventId) : null;
  const actualBytes = pendingBytes ?? alreadyStored;

  if (actualBytes === null) {
    return res.status(409).json({ error: 'No uploaded clip found - start again at step 1' });
  }

  // A truncated upload can still return 2xx from the bucket, which makes
  // it indistinguishable from a good one unless the sizes are compared.
  // 409 rather than 400: the device is not wrong, the upload is, and it
  // should keep its copy and try again.
  if (typeof bytes === 'number' && bytes !== actualBytes) {
    return res.status(409).json({
      error: `Uploaded ${actualBytes} bytes but confirm says ${bytes} - re-upload`
    });
  }

  // The same ingest path the socket and the HTTP endpoint use, which is
  // what makes `kind` on a confirm obey the same maximum rule as `kind`
  // on an alert: a late motion confirm cannot pull an event back down
  // from ring. No second implementation, so no way for the two to
  // disagree. It also creates the event when the clip arrived first.
  const result = await ingestEvent({ device: hardware, eventId, kind, at });
  if (result.outcome === REJECTED) {
    // Permanent, and the device is meant to stop. Anything transient
    // would have thrown and surfaced as a 500, which is retryable.
    return res.status(400).json({ error: result.reason });
  }

  // Only when there is something new to promote. On a re-confirm the
  // object is already in place, and copying it onto itself would be
  // work for nothing.
  if (pendingBytes !== null) await promoteUpload(hardware.deviceId, eventId);

  // Absent means "unchanged", not "false".
  //
  // A confirm is idempotent and may be sent again carrying only what has
  // changed - a ring upgrade, most obviously, has no new recording
  // behind it and no reason to repeat the duration. Writing defaults for
  // whatever this particular call left out would quietly erase a
  // `partial` flag the first confirm was explicit about.
  const fields = { status: 'stored', bytes: actualBytes, confirmedAt: new Date() };
  if (typeof durationMs === 'number') fields.durationMs = durationMs;
  if (partial !== undefined) fields.partial = Boolean(partial);

  await Clip.updateOne({ device: hardware._id, eventId }, { $set: fields }, { upsert: true });

  // 204 deliberately: the uploader is judged purely by its exit code and
  // reads no body, so there is nothing useful to send and no reason to
  // make it parse one.
  return res.status(204).end();
}

/**
 * Playback, for a person rather than a device.
 *
 * Returns a short-lived signed URL and lets the browser fetch from the
 * bucket, rather than streaming the file through here. Proxying would
 * keep this server out of the live media path only to make it a CDN for
 * the recorded one.
 *
 * Behind requireDeviceAccess, so membership is already proven; this can
 * only ever hand out a URL for a doorbell the caller belongs to.
 */
export async function getClipUrl(req, res) {
  if (!storageConfigured) return unavailable(res);

  const { eventId } = req.params;
  const clip = await Clip.findOne({ device: req.device._id, eventId, status: 'stored' });
  if (!clip) return res.status(404).json({ error: 'No clip for that event' });

  const grant = await signPlayback(req.device.deviceId, eventId);
  return res.json({
    ...grant,
    durationMs: clip.durationMs,
    partial: clip.partial,
    bytes: clip.bytes
  });
}
