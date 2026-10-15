import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useDevices } from '../context/DevicesContext';
import { useDeviceLive } from './DeviceLayout';
import { Toggle } from './Toggle';
import { api } from '../api/client';
import styles from './SoftwareSection.module.css';

/*
 * The doorbell's software: what it runs, whether there is something newer,
 * and what happened to the last update.
 *
 * The device record says how things stood when the page loaded; the socket's
 * `software` frames say how they stand now. The newest of the two wins, so a
 * download's progress moves while you watch and a rollback appears the
 * moment the doorbell comes back and says which version it is on.
 */

const IN_FLIGHT = ['sent', 'downloading', 'installing', 'rebooting', 'trial'];

const NAMES_LOCALE = 'en-US';

// A version of null means the factory system only from a doorbell that can
// report one. An older bridge sends no version at all, and that is unknown.
function versionLabel(firmware) {
  if (!firmware || (!firmware.version && !firmware.updater)) return 'Unknown';
  return firmware.version || 'Factory version';
}

function formatDay(iso) {
  if (!iso) return null;
  const date = new Date(iso);
  const days = Math.round((Date.now() - date.getTime()) / (24 * 60 * 60 * 1000));
  if (days < 1 && new Date().getDate() === date.getDate()) return 'today';
  if (days <= 1) return 'yesterday';
  return `on ${date.toLocaleDateString(NAMES_LOCALE, { month: 'short', day: 'numeric' })}`;
}

/** What is happening right now, in a sentence, while an update runs. */
function progressLine(update) {
  switch (update.state) {
    case 'sent':
      return `Starting the update to ${update.version}…`;
    case 'downloading':
      return `Downloading ${update.version}${
        update.progress != null ? ` — ${Math.round(update.progress * 100)}%` : '…'
      }`;
    case 'installing':
      return `Installing ${update.version}…`;
    case 'rebooting':
      return `Restarting into ${update.version} — back in about a minute`;
    case 'trial':
      return `Running ${update.version} — making sure it's healthy`;
    default:
      return null;
  }
}

export function SoftwareSection({ device }) {
  const { token } = useAuth();
  const { updateDevice } = useDevices();
  const { software: live } = useDeviceLive();

  const [release, setRelease] = useState(undefined);
  const [answer, setAnswer] = useState(null); // the last Update now response
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getLatestRelease(token)
      .then(({ release }) => !cancelled && setRelease(release))
      .catch(() => !cancelled && setRelease(null));
    return () => {
      cancelled = true;
    };
  }, [token]);

  // Newest wins: a push after the page loaded, or our own Update now answer.
  const firmware = live?.firmware ?? device.firmware ?? null;
  const update = answer?.update ?? live?.update ?? device.update ?? null;
  const failedVersion = live?.failedVersion ?? device.failedVersion ?? null;
  const autoUpdate = device.autoUpdate !== false;

  // A push supersedes our own answer as soon as one arrives.
  useEffect(() => {
    if (live) setAnswer(null);
  }, [live]);

  const online = device.status === 'online';
  const canUpdateItself = Boolean(firmware?.updater);
  const current = firmware?.version ?? null;
  const behind = Boolean(release && canUpdateItself && current !== release.version);
  const running = update && IN_FLIGHT.includes(update.state);

  const updateNow = async () => {
    setBusy(true);
    setError(null);
    try {
      const { update: started } = await api.requestUpdate(token, device._id);
      setAnswer({ update: started });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  /*
   * The one line under the version that says where things stand. Ordered
   * by what matters most: something going on now, then something that went
   * wrong, then something available, then all's well.
   */
  let status = null;
  let tone = 'quiet';
  let offerButton = false;

  if (!firmware && device.status === 'unprovisioned') {
    status = null;
  } else if (firmware && !canUpdateItself) {
    status = 'This doorbell needs one manual update before it can update itself.';
  } else if (running) {
    status = progressLine(update);
    tone = 'busy';
  } else if (update?.state === 'rolled-back' && failedVersion === release?.version) {
    status = `The update to ${update.version} didn't start properly, so the doorbell went back to ${versionLabel(
      firmware
    )}. It won't try that version again on its own.`;
    tone = 'bad';
    offerButton = true;
  } else if (update?.state === 'failed' && update.version === release?.version) {
    status = `The update to ${update.version} didn't finish: ${update.error || 'unknown reason'}.${
      autoUpdate ? ' It will try again tomorrow night.' : ''
    }`;
    tone = 'bad';
    offerButton = true;
  } else if (behind) {
    status = autoUpdate
      ? `${release.version} is available. It installs tonight between 3 and 4 am.`
      : `${release.version} is available.`;
    tone = 'news';
    offerButton = true;
  } else if (release && canUpdateItself) {
    const when = update?.state === 'done' && update.version === current ? formatDay(update.finishedAt) : null;
    status = when ? `Up to date — updated ${when}.` : 'Up to date.';
    tone = 'good';
  }

  // "What's new" for whatever the person is looking at: the release on
  // offer, or the one they are running.
  const notes = release?.notes && (behind || current === release.version) ? release.notes : null;

  return (
    <>
      <p className={styles.sectionLabel}>Software</p>
      <div className={styles.group}>
        <div className={styles.row}>
          <span className={styles.muted}>Version</span>
          <span>{versionLabel(firmware)}</span>
        </div>

        {status && (
          <div className={`${styles.status} ${styles[`tone_${tone}`]}`} role="status">
            <p className={styles.statusText}>{status}</p>
            {running && update.state === 'downloading' && update.progress != null && (
              <span className={styles.bar} aria-hidden="true">
                <span style={{ width: `${Math.round(update.progress * 100)}%` }} />
              </span>
            )}
          </div>
        )}

        {notes && (
          <details className={styles.notes} open={behind}>
            <summary>What&apos;s new in {release.version}</summary>
            <p>{notes}</p>
          </details>
        )}

        {offerButton && (
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.updateBtn}
              onClick={updateNow}
              disabled={busy || !online}
            >
              {busy ? 'Starting…' : tone === 'bad' ? 'Try again now' : 'Update now'}
            </button>
            <p className={styles.hint}>
              {online
                ? 'The doorbell restarts for about a minute at the end.'
                : 'The doorbell is offline — it can update once it is back.'}
            </p>
          </div>
        )}
        {error && <p className={styles.error}>{error}</p>}

        {canUpdateItself && (
          <div className={styles.toggleRow}>
            <div>
              <p className={styles.label}>Update automatically</p>
              <p className={styles.muted}>Overnight, between 3 and 4 am</p>
            </div>
            <Toggle
              label="Update automatically"
              checked={autoUpdate}
              onChange={(value) => updateDevice(device._id, { autoUpdate: value })}
            />
          </div>
        )}
      </div>
    </>
  );
}
