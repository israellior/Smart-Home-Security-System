import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useDeviceLive } from './DeviceLayout';
import { WifiIcon } from './Icons';
import { wifiSignal } from '../lib/wifiSignal';
import { api } from '../api/client';
import styles from './WifiSection.module.css';

/*
 * The doorbell's Wi-Fi: which network, how strong, and changing it.
 *
 * Two situations, and they need opposite things. A doorbell that is online
 * can be asked to move: it shows what it can see, takes a password, and
 * keeps its old network until the new one works. A doorbell that went
 * offline because the Wi-Fi changed cannot be asked anything - but after a
 * restart it raises its own setup network, and all that is missing is
 * somebody telling you so.
 */

// A scan takes a few seconds on the doorbell. Past this, say so.
const SCAN_PATIENCE_MS = 20_000;
// A move is up to three join attempts, a check, and a fall back - and the
// answer has to wait for the doorbell to come back on whichever network won.
const JOIN_PATIENCE_MS = 6 * 60 * 1000;

// A scan reports signal as 0-100, not dBm. The same three bars.
function barsFor(percent) {
  if (percent >= 67) return 3;
  if (percent >= 40) return 2;
  if (percent >= 15) return 1;
  return 0;
}

function OfflineHelp({ setupSsid }) {
  return (
    <div className={styles.help}>
      <p className={styles.helpTitle}>Changed your Wi-Fi?</p>
      <p className={styles.muted}>
        The doorbell can&apos;t reach its old network, so it can&apos;t be changed from here.
        It can be from your phone:
      </p>
      <ol className={styles.steps}>
        <li>Unplug the doorbell for 10 seconds, then plug it back in.</li>
        <li>
          After about a minute, open your phone&apos;s Wi-Fi settings and join{' '}
          {setupSsid ? <strong>{setupSsid}</strong> : 'the network called Porchlight-…'}. Its
          password is on the sticker on the doorbell.
        </li>
        <li>
          A page opens: choose your new network and enter its password. The doorbell comes back
          online here within a minute.
        </li>
      </ol>
    </div>
  );
}

export function WifiSection({ device }) {
  const { token } = useAuth();
  const { rssi, ssid, wifiNetworks, wifiStatus } = useDeviceLive();

  const [open, setOpen] = useState(false);
  const [scanAskedAt, setScanAskedAt] = useState(null);
  const [choice, setChoice] = useState(null); // an ssid, or '' for "other"
  const [other, setOther] = useState('');
  const [password, setPassword] = useState('');
  const [join, setJoin] = useState(null); // { id, ssid, at }
  const [error, setError] = useState(null);
  const [, tick] = useState(0);

  const online = device.status === 'online';
  const canChange = Boolean(device.firmware?.wifi);
  const signal = wifiSignal(rssi);

  // The answer to our own move, matched on its id - not anybody else's.
  const result = join && wifiStatus?.id === join.id ? wifiStatus : null;
  const joining = join && (!result || result.state === 'joining');
  const finished = result && result.state !== 'joining' ? result : null;

  // Re-render while waiting, so "taking longer than usual" can appear.
  useEffect(() => {
    if (!joining && !(open && scanAskedAt)) return undefined;
    const timer = setInterval(() => tick((n) => n + 1), 5000);
    return () => clearInterval(timer);
  }, [joining, open, scanAskedAt]);

  const scanned = wifiNetworks && scanAskedAt && wifiNetworks.at >= scanAskedAt ? wifiNetworks : null;
  const scanSlow = open && scanAskedAt && !scanned && Date.now() - scanAskedAt > SCAN_PATIENCE_MS;
  const joinSlow = joining && Date.now() - join.at > JOIN_PATIENCE_MS;

  const startChange = async () => {
    setOpen(true);
    setError(null);
    setChoice(null);
    setPassword('');
    setOther('');
    setJoin(null);
    const at = Date.now();
    setScanAskedAt(at);
    try {
      await api.scanWifi(token, device._id);
    } catch (err) {
      setError(err.message);
    }
  };

  const target = choice === '' ? other.trim() : choice;
  const chosen = scanned?.networks.find((n) => n.ssid === choice);
  const needsPassword = choice === '' || chosen?.secure !== false;
  const ready = Boolean(target) && (!needsPassword || password.length >= 8);

  const connect = async (e) => {
    e.preventDefault();
    if (!ready) return;
    setError(null);
    try {
      const { id } = await api.joinWifi(token, device._id, target, needsPassword ? password : '');
      setJoin({ id, ssid: target, at: Date.now() });
      setPassword('');
      setOpen(false);
    } catch (err) {
      setError(err.message);
    }
  };

  const current = ssid || scanned?.current || null;

  return (
    <>
      <p className={styles.sectionLabel} id="wifi">
        Wi-Fi
      </p>
      <div className={styles.group}>
        <div className={styles.row}>
          <span className={styles.muted}>Network</span>
          <span className={styles.network}>
            {online && signal && <WifiIcon size={15} level={signal.level} />}
            {online ? current || 'Connected' : 'Offline'}
            {online && signal && <span className={styles.muted}> · {signal.label}</span>}
          </span>
        </div>

        {/* A move in progress, or its outcome - shown whether or not the
            doorbell is online right now, because it goes offline for a
            moment in the middle of one. */}
        {joining && (
          <div className={`${styles.status} ${styles.tone_busy}`} role="status">
            <p>
              Moving to <strong>{join.ssid}</strong>… The doorbell is offline for a minute or two
              while it switches.
            </p>
            {joinSlow && (
              <p className={styles.muted}>
                This is taking longer than usual. If the doorbell stays offline, use the steps below.
              </p>
            )}
          </div>
        )}
        {finished?.state === 'connected' && (
          <div className={`${styles.status} ${styles.tone_good}`} role="status">
            <p>
              Now on <strong>{finished.ssid}</strong>.
            </p>
          </div>
        )}
        {finished?.state === 'failed' && (
          <div className={`${styles.status} ${styles.tone_bad}`} role="status">
            <p>
              Couldn&apos;t use <strong>{finished.ssid}</strong>. {finished.error}
            </p>
            {finished.previous && (
              <p className={styles.muted}>It&apos;s back on {finished.previous}.</p>
            )}
          </div>
        )}

        {online && canChange && !joining && !open && (
          <button type="button" className={styles.changeBtn} onClick={startChange}>
            Change network
          </button>
        )}

        {online && canChange && open && !joining && (
          <form className={styles.panel} onSubmit={connect}>
            {!scanned && !scanSlow && <p className={styles.muted}>Looking for networks…</p>}
            {scanSlow && (
              <p className={styles.muted}>
                The doorbell didn&apos;t answer with a list. You can still type the network&apos;s
                name under &ldquo;Other network&rdquo;.
              </p>
            )}

            <div className={styles.list} role="radiogroup" aria-label="Networks the doorbell can see">
              {scanned?.networks.map((n) => (
                <button
                  key={n.ssid}
                  type="button"
                  role="radio"
                  aria-checked={choice === n.ssid}
                  className={`${styles.option} ${choice === n.ssid ? styles.optionOn : ''}`}
                  onClick={() => setChoice(n.ssid)}
                >
                  <WifiIcon size={16} level={barsFor(n.signal)} />
                  <span className={styles.optionName}>{n.ssid}</span>
                  {n.ssid === current && <span className={styles.tag}>Connected</span>}
                  {!n.secure && <span className={styles.tag}>Open</span>}
                </button>
              ))}
              {(scanned || scanSlow) && (
                <button
                  type="button"
                  role="radio"
                  aria-checked={choice === ''}
                  className={`${styles.option} ${choice === '' ? styles.optionOn : ''}`}
                  onClick={() => setChoice('')}
                >
                  <span className={styles.optionName}>Other network…</span>
                </button>
              )}
            </div>

            {choice === '' && (
              <input
                className={styles.input}
                placeholder="Network name"
                value={other}
                maxLength={32}
                autoCapitalize="none"
                autoCorrect="off"
                onChange={(e) => setOther(e.target.value)}
              />
            )}
            {choice !== null && needsPassword && (
              <input
                className={styles.input}
                type="password"
                placeholder="Password"
                value={password}
                maxLength={63}
                autoComplete="off"
                onChange={(e) => setPassword(e.target.value)}
              />
            )}

            <div className={styles.actions}>
              <button type="submit" className={styles.connectBtn} disabled={!ready}>
                Connect
              </button>
              <button type="button" className={styles.cancelBtn} onClick={() => setOpen(false)}>
                Cancel
              </button>
            </div>
            <p className={styles.muted}>
              If the doorbell can&apos;t get online through the new network, it goes back to{' '}
              {current || 'its current one'} by itself.
            </p>
          </form>
        )}

        {error && <p className={styles.error}>{error}</p>}

        {online && !canChange && (
          <p className={styles.muted}>
            Update the doorbell&apos;s software to change its Wi-Fi from here.
          </p>
        )}

        {!online && !joining && device.status !== 'never-connected' && (
          <OfflineHelp setupSsid={device.setupSsid} />
        )}
      </div>
    </>
  );
}
