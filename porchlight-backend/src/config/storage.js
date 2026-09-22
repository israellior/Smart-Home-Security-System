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

// Short on purpose. The uploader never caches a grant between attempts -
// every retry starts again at step 1 - so a long expiry buys nothing and
// widens the window on a URL that has leaked.
const UPLOAD_URL_TTL_SECONDS = 300;

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
 * A grant to upload exactly one object.
 *
 * `signableHeaders` is pinned to host alone. Anything else we sign here
 * becomes a header the device is required to send byte-for-byte, and the
 * device sends a fixed set we do not control. Content-Type rides in the
 * returned `headers` instead, which the uploader copies verbatim onto
 * the PUT.
 */
export async function signUpload(deviceId, eventId) {
  const key = pendingKey(deviceId, eventId);
  const url = await getSignedUrl(
    requireClient(),
    new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, ContentType: CONTENT_TYPE }),
    { expiresIn: UPLOAD_URL_TTL_SECONDS, signableHeaders: new Set(['host']) }
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

export async function deleteClipObjects(deviceId, eventIds) {
  const s3 = requireClient();
  await Promise.allSettled(
    eventIds.flatMap((eventId) =>
      [clipKey(deviceId, eventId), pendingKey(deviceId, eventId)].map((Key) =>
        s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key }))
      )
    )
  );
}
