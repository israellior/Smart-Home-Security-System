import { Release } from '../models/Release.js';
import { storageConfigured, signReleaseUpload, releaseSize } from '../config/storage.js';
import { latestRelease, offerUpdate } from '../services/updates/index.js';

// What a version may look like: what make-bundle.sh writes into a manifest,
// and safe as one path segment in the bucket.
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;

// A bundle is ~90 MB today. Far above that is a mistake, not a release.
const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;
const MAX_NOTES = 2000;

function releaseForApp(release) {
  if (!release) return null;
  return { version: release.version, notes: release.notes, publishedAt: release.publishedAt };
}

/** The release every doorbell is being brought to, for the app to show. */
export async function getLatestRelease(req, res) {
  return res.json({ release: releaseForApp(await latestRelease()) });
}

/**
 * Update now. Any member, like the other settings: it is the same update
 * the doorbell would take tonight, only sooner. The doorbell restarts for
 * about a minute at the end, which the app says before anyone presses it.
 *
 * Also how a release that rolled back can be tried again by hand - the
 * nightly schedule will not, but a person who has read why may.
 */
const REFUSALS = {
  offline: [409, 'The doorbell is offline. It updates the next time it is online overnight.'],
  'no-updater': [409, 'This doorbell needs one manual update before it can update itself.'],
  busy: [409, 'An update is already under way.'],
  storage: [503, 'Updates are not configured on this server.']
};

export async function requestUpdate(req, res) {
  const release = await latestRelease();
  if (!release) return res.status(404).json({ error: 'No update has been published yet' });
  if (req.device.firmware?.version === release.version) {
    return res.status(409).json({ error: 'Already up to date' });
  }

  const result = await offerUpdate(req.device, release);
  if (!result.sent) {
    const [status, error] = REFUSALS[result.reason] || [500, 'The update could not be started'];
    return res.status(status).json({ error });
  }
  return res.status(202).json({ update: result.device.update });
}

/**
 * Publishing, step 1: register the release and get somewhere to put it.
 * Repeatable until it is published, so a failed upload is retried by
 * running the script again; a published version is never replaced, because
 * doorbells may already be running what it describes.
 */
export async function createRelease(req, res) {
  if (!storageConfigured) return res.status(503).json({ error: 'Clip storage is not configured' });

  const { version, notes = '', bytes, sha256 } = req.body || {};
  if (typeof version !== 'string' || !VERSION.test(version)) {
    return res.status(400).json({ error: 'version must be letters, digits, dots, dashes or underscores' });
  }
  if (!Number.isInteger(bytes) || bytes <= 0 || bytes > MAX_BUNDLE_BYTES) {
    return res.status(400).json({ error: '`bytes` must be the bundle size' });
  }
  if (typeof sha256 !== 'string' || !SHA256.test(sha256)) {
    return res.status(400).json({ error: '`sha256` must be 64 lowercase hex digits' });
  }
  if (typeof notes !== 'string' || notes.length > MAX_NOTES) {
    return res.status(400).json({ error: `notes must be text, at most ${MAX_NOTES} characters` });
  }

  const existing = await Release.findOne({ version });
  if (existing?.status === 'published') {
    return res.status(409).json({ error: `${version} is already published` });
  }

  await Release.findOneAndUpdate(
    { version },
    { $set: { notes: notes.trim(), bytes, sha256, status: 'uploading' } },
    { upsert: true }
  );
  const grant = await signReleaseUpload(version, bytes);
  return res.status(201).json(grant);
}

/** Step 2, after the PUT: check the bucket has it, then offer it. */
export async function publishRelease(req, res) {
  const release = await Release.findOne({ version: req.params.version });
  if (!release) return res.status(404).json({ error: 'No such release' });
  if (release.status === 'published') return res.json({ release: releaseForApp(release) });

  const size = await releaseSize(release.version);
  if (size === null) return res.status(409).json({ error: 'The bundle has not been uploaded' });
  if (size !== release.bytes) {
    return res.status(409).json({ error: `Uploaded ${size} bytes, expected ${release.bytes}` });
  }

  release.status = 'published';
  release.publishedAt = new Date();
  await release.save();
  console.log(`Update: published ${release.version}`);
  return res.json({ release: releaseForApp(release) });
}
