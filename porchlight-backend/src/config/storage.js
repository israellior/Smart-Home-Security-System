import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * Clip storage: Cloudflare R2, spoken to over the S3 API.
 *
 * The server never carries a byte of video. It hands the doorbell a
 * short-lived URL to PUT to and hands a viewer a short-lived URL to GET
 * from, and the bytes go directly between them and the bucket. That is
 * the same rule that keeps this server out of the live media path,
 * applied to the recorded one - proxying clips would turn the app server
 * into a video CDN for no reason.
 *
 * The device never holds bucket credentials. What it gets is scoped to
 * one object, PUT only, for a few minutes. A stolen doorbell can write
 * one clip; it cannot read or delete anything.
 */

// Long enough that a grant outlives a bad patch of confirms.
//
// This was five minutes on the reasoning that the uploader never caches
// a grant, so a longer window bought nothing. The device side measured
// what that actually costs: a confirm that fails re-PUTs the whole file,
// about 3.5MB with a real camera, roughly every 60 seconds for as long
// as the failure lasts.
//
// And our confirm genuinely can fail for minutes - it needs Mongo, and
// this cluster drops operations in bursts; one measured run lost 33 of
// 40 writes transiently. Fifteen minutes lets the uploader reuse a grant
// and retry step 3 alone about a dozen times before it has to re-upload
// anything. The exposure is unchanged in kind: one object, PUT only.
const UPLOAD_URL_TTL_SECONDS = 900;

// Long enough to start playback and seek around a 20-second clip.
const PLAYBACK_URL_TTL_SECONDS = 900;

const CONTENT_TYPE = 'video/mp4';

const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = process.env;

/**
 * Clip storage is optional. Without it the rest of the app - accounts,
 * alerts, the signaling socket, live activity - runs exactly as before
 * and only the clip endpoints report themselves unavailable. A doorbell
 * that cannot upload keeps its recording and retries, which is precisely
 * the behaviour it already has for every other transient failure.
 */
export const storageConfigured = Boolean(
  R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET
);

const client = storageConfigured
  ? new S3Client({
      region: 'auto',
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },

      // These two lines are the whole reason uploads work, and they are
      // not a tuning knob.
      //
      // The uploader on the Pi is Python's urllib. It sends Host,
      // User-Agent, Accept-Encoding, Content-Length and Content-Type -
      // and no checksum header of any kind. Since SDK v3.729 the client
      // adds x-amz-sdk-checksum-algorithm to PutObject by default, and
      // if that lands in the signature then a client which does not send
      // it fails every upload with a signature mismatch.
      //
      // From our side that failure is invisible: we generate a URL that
      // looks perfectly good, and the device sees a non-2xx it can only
      // retry forever. Verified against the live bucket with a client
      // that sends exactly urllib's headers and nothing else.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED'
    })
  : null;

function requireClient() {
  if (!client) throw new Error('Clip storage is not configured');
  return client;
}

/**
 * Object keys, derived rather than stored.
 *
 * Uploads land under `pending/` and move to `clips/` on confirm. The
 * split exists so "an object nobody confirmed" is answerable by prefix,
 * which lets a bucket lifecycle rule expire them with no cron job and no
 * sweeper process of ours. The move costs one server-side copy and one
 * delete per clip - no egress, and well inside R2's free operation
 * allowance.
 *
 * encodeURIComponent because an eventId is chosen by the device and only
 * promised to be a string. A UUID passes through unchanged, so the
 * normal case stays readable in the bucket, and anything stranger is
 * still a safe single path segment rather than a way to write outside
 * the prefix.
 */
export function pendingKey(deviceId, eventId) {
  return `pending/${deviceId}/${encodeURIComponent(eventId)}.mp4`;
}

export function clipKey(deviceId, eventId) {
  return `clips/${deviceId}/${encodeURIComponent(eventId)}.mp4`;
}

/**
 * A grant to upload exactly one object, of exactly `bytes` bytes - or,
 * with no `bytes`, of any size.
 *
 * Signing Content-Length makes the grant good for that many bytes and no
 * other - the bucket refuses anything else on signature alone. That is
 * the whole of the size limit: a presigned PUT has no other way to say
 * "no larger than". Both callers know the size before they ask - a
 * doorbell's clip is finished before it is uploaded, and so is a
 * recording from the live view - so neither has a reason to be given an
 * open-ended grant.
 *
 * Anything signed becomes a header the client must send byte-for-byte,
 * so the set is exactly what both clients already send and nothing
 * more: Host, Content-Length (which urllib and fetch both compute from
 * the body) and Content-Type (copied verbatim from the `headers` this
 * returns). No checksum header - see the client options above.
 *
 * The open-ended form exists for one reason and should not outlive it:
 * the doorbells in the field do not send their size yet. See
 * createUploadUrl in clipController.js.
 */
export async function signUpload(deviceId, eventId, { bytes } = {}) {
  const sized = bytes !== undefined;
  if (sized && (!Number.isInteger(bytes) || bytes <= 0)) {
    throw new Error('signUpload was given a size that is not a positive integer');
  }

  const key = pendingKey(deviceId, eventId);
  const url = await getSignedUrl(
    requireClient(),
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      ContentType: CONTENT_TYPE,
      ...(sized && { ContentLength: bytes })
    }),
    {
      expiresIn: UPLOAD_URL_TTL_SECONDS,
      signableHeaders: new Set(
        // Unsized is exactly what production signed for a doorbell before
        // this: host alone, so a device's uploader is held to nothing new.
        sized ? ['host', 'content-length', 'content-type'] : ['host']
      )
    }
  );

  return {
    url,
    method: 'PUT',
    // The only place metadata can be attached: the uploader adds nothing
    // of its own beyond what urllib sends.
    headers: { 'Content-Type': CONTENT_TYPE },
    expiresAt: new Date(Date.now() + UPLOAD_URL_TTL_SECONDS * 1000).toISOString()
  };
}

export async function signPlayback(deviceId, eventId) {
  const url = await getSignedUrl(
    requireClient(),
    new GetObjectCommand({ Bucket: R2_BUCKET, Key: clipKey(deviceId, eventId) }),
    { expiresIn: PLAYBACK_URL_TTL_SECONDS }
  );

  return {
    url,
    expiresAt: new Date(Date.now() + PLAYBACK_URL_TTL_SECONDS * 1000).toISOString()
  };
}

/** Size of an object, or null if it isn't there. */
async function sizeOf(key) {
  try {
    const head = await requireClient().send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    return head.ContentLength ?? null;
  } catch (err) {
    // NotFound is an answer, not a failure: the caller is asking about
    // something that may legitimately not have been uploaded.
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

/** A freshly uploaded object, still awaiting confirmation. */
export function uploadedSize(deviceId, eventId) {
  return sizeOf(pendingKey(deviceId, eventId));
}

/**
 * An already-confirmed object.
 *
 * Needed because confirming is idempotent: a device that crashed between
 * the PUT and the confirm recovers by confirming again, and by then the
 * first confirm has already moved the object out of the pending prefix.
 * Without this, the retry that is *supposed* to fix things would be told
 * nothing was ever uploaded.
 */
export function storedSize(deviceId, eventId) {
  return sizeOf(clipKey(deviceId, eventId));
}

/**
 * Promotes a confirmed upload out of the expiring prefix.
 *
 * Copy-then-delete, in that order. If the delete fails the object exists
 * in both places, which costs a few megabytes until the lifecycle rule
 * collects the pending copy - whereas deleting first and failing the
 * copy would lose the clip outright.
 */
export async function promoteUpload(deviceId, eventId) {
  const s3 = requireClient();
  const from = pendingKey(deviceId, eventId);
  const to = clipKey(deviceId, eventId);

  await s3.send(
    new CopyObjectCommand({
      Bucket: R2_BUCKET,
      Key: to,
      CopySource: `${R2_BUCKET}/${from}`,
      ContentType: CONTENT_TYPE,
      MetadataDirective: 'REPLACE'
    })
  );

  try {
    await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: from }));
  } catch (err) {
    console.error(`Could not remove pending clip ${from}:`, err.message);
  }

  return to;
}

// Deletes in flight at once. A doorbell being deleted or a week of clips
// expiring can be hundreds of objects, and one request each all at once is
// a burst R2 has no reason to enjoy.
const DELETE_CONCURRENCY = 16;

/**
 * Removes every object an event can have - its clip and any upload that
 * never got confirmed - and returns how many deletes failed.
 *
 * One DeleteObject per key rather than a batch DeleteObjects: the batch
 * call requires a checksum header, and the client above is configured
 * precisely so that nothing adds one (see requestChecksumCalculation).
 * Deleting a key that does not exist succeeds, so asking for both is free.
 */
export async function deleteClipObjects(deviceId, eventIds) {
  const keys = eventIds.flatMap((eventId) => [
    clipKey(deviceId, eventId),
    pendingKey(deviceId, eventId)
  ]);
  return deleteKeys(keys);
}

/** Deletes these keys, a few at a time, and returns how many failed. */
async function deleteKeys(keys) {
  const s3 = requireClient();
  let failed = 0;
  for (let i = 0; i < keys.length; i += DELETE_CONCURRENCY) {
    const results = await Promise.allSettled(
      keys
        .slice(i, i + DELETE_CONCURRENCY)
        .map((Key) => s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key })))
    );
    failed += results.filter((r) => r.status === 'rejected').length;
  }
  return failed;
}

// --- Releases --------------------------------------------------------------
//
// Software bundles for the doorbells live in the same bucket, under their own
// prefix: one object per version, written once by the publish script and read
// by every doorbell that updates to it. No lifecycle rule touches releases/.

const BUNDLE_TYPE = 'application/octet-stream';

// Long enough for a home connection to pull ~90 MB with room for a stall and
// a retry. The URL is good for one object, GET only.
const BUNDLE_URL_TTL_SECONDS = 2 * 60 * 60;

export function releaseKey(version) {
  return `releases/${encodeURIComponent(version)}.raucb`;
}

/** A grant for the publish script to upload exactly `bytes` of one bundle. */
export async function signReleaseUpload(version, bytes) {
  const url = await getSignedUrl(
    requireClient(),
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: releaseKey(version),
      ContentType: BUNDLE_TYPE,
      ContentLength: bytes
    }),
    {
      expiresIn: UPLOAD_URL_TTL_SECONDS,
      signableHeaders: new Set(['host', 'content-length', 'content-type'])
    }
  );
  return { url, method: 'PUT', headers: { 'Content-Type': BUNDLE_TYPE } };
}

/** Where a doorbell downloads a bundle from. */
export async function signReleaseDownload(version) {
  return getSignedUrl(
    requireClient(),
    new GetObjectCommand({ Bucket: R2_BUCKET, Key: releaseKey(version) }),
    { expiresIn: BUNDLE_URL_TTL_SECONDS }
  );
}

export function releaseSize(version) {
  return sizeOf(releaseKey(version));
}

// --- Faces -----------------------------------------------------------------
//
// The photos a doorbell's known people were saved from: one cropped face
// each, JPEG, a few tens of kilobytes. Unlike clips this server does carry
// these bytes, once, on the way in - they are small, they come from a
// member's browser, and checking them here is simpler than signing an upload
// for each. They go out the usual way: a signed GET, to the doorbell, which
// codes them and keeps no picture, and to the app, to show who is saved.
//
// No lifecycle rule: a photo lives exactly as long as its person, and
// deleting the person or the doorbell deletes it - see services/faces.js and
// services/devices.js.

const FACE_TYPE = 'image/jpeg';

// The doorbell may be busy recording when the list arrives and get to the
// photos late; the brief promises it at least an hour.
const FACE_URL_TTL_SECONDS = 2 * 60 * 60;

/** Ids are checked before they get here - see services/faces.js. */
export function faceKey(deviceId, personId, photoId) {
  return `faces/${deviceId}/${personId}/${photoId}.jpg`;
}

export async function putFacePhoto(key, bytes) {
  await requireClient().send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: bytes,
      ContentType: FACE_TYPE,
      ContentLength: bytes.length
    })
  );
}

export function signFaceDownload(key) {
  return getSignedUrl(requireClient(), new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }), {
    expiresIn: FACE_URL_TTL_SECONDS
  });
}

export function deleteFaceObjects(keys) {
  return deleteKeys(keys);
}
