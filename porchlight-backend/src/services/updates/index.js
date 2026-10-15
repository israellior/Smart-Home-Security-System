import { Device } from '../../models/Device.js';
import { Release } from '../../models/Release.js';
import { storageConfigured, signReleaseDownload } from '../../config/storage.js';
import * as registry from '../../signaling/registry.js';

/**
 * Software updates for the doorbells: who gets which release, when, and
 * what became of it.
 *
 * The doorbell does the dangerous part on its own and has proven it can:
 * RAUC writes the slot it is not running, U-Boot boots it on trial, and
 * porchlight-health marks it bad and falls back if porchlightd is not
 * steady within five minutes. This side only decides when to ask, and
 * reads the outcome from what the doorbell reports when it comes back.
 *
 *   sent -> downloading -> installing -> rebooting      (the doorbell says)
 *        -> trial        it came back on the new version (its hello says)
 *        -> done         and was still on it after the rollback window
 *        -> rolled-back  it came back on the old one
 *   any of the first four -> failed                     (it said, or went quiet)
 *
 * In memory for nothing: every state is on the Device, so a server restart
 * mid-update picks up where it was from the doorbell's next hello.
 */

const IN_FLIGHT = ['sent', 'downloading', 'installing', 'rebooting'];

// porchlight-health gives a new slot five minutes to be steady before it
// marks it bad and reboots into the old one. Past this, a doorbell still on
// the new version has kept it.
const TRIAL_MS = 10 * 60 * 1000;

// An update that has said nothing for this long is not going to. Generous:
// a slow home connection downloading ~90 MB reports progress throughout, so
// silence this long means the updater or the doorbell is gone.
const STALE_MS = 45 * 60 * 1000;

// Updates install between 3 and 4 in the morning at the doorbell. The tick
// below runs every five minutes, so a doorbell online during that hour is
// asked about a dozen times - harmlessly, because an update in flight is
// never offered again.
const QUIET_HOUR = 3;
const TICK_MS = 5 * 60 * 1000;

// A release whose download or install failed - not one that rolled back -
// is tried again, but not the same night: a failure that repeats every five
// minutes is a doorbell restarting nothing but its own attempts.
const RETRY_FAILED_AFTER_MS = 20 * 60 * 60 * 1000;

function send(socket, payload) {
  if (!socket || socket.readyState !== socket.OPEN) return false;
  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

/** What the app shows about a doorbell's software, pushed on every change. */
export function softwareOf(device) {
  return {
    firmware: device.firmware ?? null,
    update: device.update ?? null,
    failedVersion: device.failedVersion ?? null,
    autoUpdate: device.autoUpdate !== false
  };
}

function announce(device) {
  if (!device) return;
  const payload = { type: 'software', ...softwareOf(device.toJSON ? device.toJSON() : device) };
  for (const socket of registry.browserSockets(String(device._id))) send(socket, payload);
}

export function latestRelease() {
  return Release.findOne({ status: 'published' }).sort({ publishedAt: -1 }).lean();
}

/**
 * Asks one doorbell to install one release. Returns `{ sent, reason }`.
 *
 * The state is written before the frame goes, and only if no update is
 * already in flight - the guard is in the write itself, so the nightly tick
 * and someone pressing Update now at the same moment cannot both send one.
 */
export async function offerUpdate(device, release) {
  const deviceKey = String(device._id);
  const socket = registry.deviceSocket(deviceKey);
  if (!socket) return { sent: false, reason: 'offline' };
  if (!socket.ctx?.updater) return { sent: false, reason: 'no-updater' };
  if (!storageConfigured) return { sent: false, reason: 'storage' };

  const url = await signReleaseDownload(release.version);
  const now = new Date();
  const claimed = await Device.findOneAndUpdate(
    {
      _id: device._id,
      $or: [{ update: null }, { 'update.state': { $nin: [...IN_FLIGHT, 'trial'] } }]
    },
    {
      $set: {
        update: {
          state: 'sent',
          version: release.version,
          fromVersion: device.firmware?.version ?? null,
          startedAt: now,
          changedAt: now
        }
      }
    },
    { new: true }
  );
  if (!claimed) return { sent: false, reason: 'busy' };

  const delivered = send(socket, {
    type: 'update',
    version: release.version,
    url,
    bytes: release.bytes,
    sha256: release.sha256
  });

  if (!delivered) {
    const failed = await setState(claimed, 'failed', { error: 'The doorbell could not be reached' });
    announce(failed);
    return { sent: false, reason: 'offline' };
  }

  console.log(`Update: offered ${release.version} to ${device.deviceId}`);
  announce(claimed);
  return { sent: true, device: claimed };
}

async function setState(device, state, { error = null, progress = null, extra = {} } = {}) {
  const now = new Date();
  const finished = ['done', 'failed', 'rolled-back'].includes(state);
  return Device.findByIdAndUpdate(
    device._id,
    {
      $set: {
        'update.state': state,
        'update.changedAt': now,
        'update.error': error,
        'update.progress': progress,
        ...(finished && { 'update.finishedAt': now }),
        ...extra
      }
    },
    { new: true }
  );
}

/**
 * The doorbell's own reports while it works: downloading (with progress),
 * installing, rebooting, or failed with a reason. Matched on the version
 * being installed, so a report from an update the server has since given up
 * on cannot move a newer one.
 */
const REPORTED_STATES = ['downloading', 'installing', 'rebooting', 'failed'];

export async function handleUpdateStatus(device, frame) {
  const { state, version } = frame;
  if (!REPORTED_STATES.includes(state) || typeof version !== 'string') return;

  const progress = Number.isFinite(frame.progress) ? Math.max(0, Math.min(1, frame.progress)) : null;
  const error = typeof frame.error === 'string' ? frame.error.slice(0, 300) : null;
  const now = new Date();
  const updated = await Device.findOneAndUpdate(
    { _id: device._id, 'update.version': version, 'update.state': { $in: IN_FLIGHT } },
    {
      $set: {
        'update.state': state,
        'update.changedAt': now,
        'update.progress': state === 'downloading' ? progress : null,
        'update.error': state === 'failed' ? error || 'The update did not install' : null,
        ...(state === 'failed' && { 'update.finishedAt': now })
      }
    },
    { new: true }
  );
  if (state !== 'downloading' || progress === null) {
    console.log(`Update: ${device.deviceId} ${state} ${version}${error ? ` - ${error}` : ''}`);
  }
  announce(updated);
}

/**
 * Every doorbell hello: what it is running now, and what that says about
 * the update it was last sent.
 *
 * Coming back on the new version is not yet success - the slot is on trial
 * and may still be marked bad and abandoned - so that is `trial`, and the
 * tick turns it into `done` once the window has passed. Coming back on
 * anything else after the reboot, or at any point during the trial, is the
 * rollback, and that release is not offered automatically again.
 */
export async function onDeviceHello(device, frame) {
  const version = typeof frame.version === 'string' && frame.version ? frame.version : null;
  const updater = frame.updater === true;
  const now = new Date();

  const fresh = await Device.findByIdAndUpdate(
    device._id,
    { $set: { firmware: { version, updater, reportedAt: now } } },
    { new: true }
  );
  if (!fresh) return;

  const u = fresh.update;
  let result = fresh;
  if (u && version === u.version && ['rebooting', 'installing', 'downloading', 'sent'].includes(u.state)) {
    result = await setState(fresh, 'trial');
    console.log(`Update: ${fresh.deviceId} is running ${version}, on trial`);
  } else if (u && version !== u.version && (u.state === 'rebooting' || u.state === 'trial')) {
    result = await setState(fresh, 'rolled-back', {
      error: `Went back to ${version || 'the factory version'}`,
      extra: { failedVersion: u.version }
    });
    console.log(`Update: ${fresh.deviceId} rolled back from ${u.version} to ${version}`);
  }
  announce(result);
}

/** The hour of the day at the doorbell, 0-23. */
function localHour(timeZone, now) {
  try {
    const hour = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hourCycle: 'h23',
      timeZone: timeZone || 'UTC'
    })
      .formatToParts(now)
      .find((p) => p.type === 'hour').value;
    return Number(hour);
  } catch {
    return now.getUTCHours();
  }
}

/** Whether a doorbell should be offered `release` tonight. */
function dueTonight(device, release, now) {
  if (!device.autoUpdate) return false;
  if (device.firmware?.version === release.version) return false;
  if (device.failedVersion === release.version) return false;
  const u = device.update;
  if (u && [...IN_FLIGHT, 'trial'].includes(u.state)) return false;
  if (
    u?.version === release.version &&
    u.state === 'failed' &&
    now - new Date(u.finishedAt || u.changedAt) < RETRY_FAILED_AFTER_MS
  ) {
    return false;
  }
  return localHour(device.timeZone, now) === QUIET_HOUR;
}

export async function tick(now = new Date()) {
  // Trials that lasted the window.
  const trials = await Device.find({
    'update.state': 'trial',
    'update.changedAt': { $lt: new Date(now - TRIAL_MS) }
  });
  for (const device of trials) {
    announce(await setState(device, 'done'));
    console.log(`Update: ${device.deviceId} kept ${device.update.version}`);
  }

  // Updates that went quiet.
  const stale = await Device.find({
    'update.state': { $in: IN_FLIGHT },
    'update.changedAt': { $lt: new Date(now - STALE_MS) }
  });
  for (const device of stale) {
    const error =
      device.update.state === 'rebooting'
        ? 'The doorbell restarted and has not come back'
        : 'The doorbell stopped reporting progress';
    announce(await setState(device, 'failed', { error }));
  }

  // Tonight's updates, for doorbells that are online to receive one.
  const release = await latestRelease();
  if (!release) return;
  const online = registry.updatableDeviceKeys();
  if (online.length === 0) return;
  const devices = await Device.find({ _id: { $in: online }, autoUpdate: true });
  for (const device of devices) {
    if (dueTonight(device, release, now)) await offerUpdate(device, release);
  }
}

export function startUpdateSchedule() {
  const run = () =>
    tick().catch((err) => {
      console.error('Update tick failed:', err.message);
    });
  setInterval(run, TICK_MS).unref();
}
