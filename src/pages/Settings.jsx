import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useDevices } from '../context/DevicesContext';
import { useDevice } from '../components/DeviceLayout';
import { Toggle } from '../components/Toggle';
import { DeviceSharing } from '../components/DeviceSharing';
import { DeviceDanger } from '../components/DeviceDanger';
import { SoftwareSection } from '../components/SoftwareSection';
import { WifiSection } from '../components/WifiSection';
import { PushSection } from '../components/PushSection';
import { statusLabel } from '../lib/deviceStatus';
import styles from './Settings.module.css';

// Month names in English, like the rest of the app's text; the clock
// follows the browser.
const NAMES_LOCALE = 'en-US';

function formatDate(value) {
  if (!value) return null;
  const date = new Date(value);
  const day = date.toLocaleDateString(NAMES_LOCALE, { day: 'numeric', month: 'short', year: 'numeric' });
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `${day}, ${time}`;
}

/**
 * One doorbell's settings, in the order people reach for them: what it's
 * called, what it tells *you*, who else has it, how it's connected, its
 * software, the facts about it - and, last, deleting or leaving it.
 *
 * Everything shared (name, location, Wi-Fi, updates) is the owner's to
 * change; the server refuses anyone else, and this page shows them the
 * values without the controls. Notifications are always your own.
 *
 * Things about *you* rather than this doorbell - your name, password,
 * theme, which of your devices get alerts - live on the Account page.
 */
export function Settings() {
  const device = useDevice();
  const { updateDevice, updatePreferences } = useDevices();
  const [showSaved, setShowSaved] = useState(false);
  const saveTimer = useRef(null);
  const isOwner = device.role === 'owner';

  const flashSaved = () => {
    setShowSaved(true);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => setShowSaved(false), 1400);
  };

  // flashSaved clears the previous timer, but only when there *is* a next
  // flash. Without this, changing a setting and navigating away inside
  // 1400ms leaves a timer running against an unmounted component. React 18
  // dropped the warning for that, so it fails silently rather than loudly.
  useEffect(() => () => clearTimeout(saveTimer.current), []);

  // Arriving from "Changed your Wi-Fi?" on the device page. The router does
  // not scroll to a #fragment on its own.
  const { hash } = useLocation();
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'start' });
  }, [hash]);

  const patch = (fields) => updateDevice(device._id, fields);

  // Notification toggles write your membership, not the device. (notifDaily
  // is stored too, but has no toggle until there is a daily summary.)
  const commitPrefsAndFlash = (prefs) => {
    updatePreferences(device._id, prefs);
    flashSaved();
  };

  const version = device.firmware?.version;
  const lastOnline = device.status === 'online' ? 'Now' : formatDate(device.lastContactAt);

  return (
    <section>
      <p className={styles.sectionLabel}>Doorbell</p>
      {isOwner ? (
        <>
          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel} htmlFor="device-name">
              Name
            </label>
            <p className={styles.fieldHelp}>Shown in everyone's list of doorbells and in alerts</p>
            <input
              id="device-name"
              className={styles.textInput}
              type="text"
              maxLength={40}
              value={device.name}
              onChange={(e) => patch({ name: e.target.value })}
              onBlur={flashSaved}
            />
          </div>

          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel} htmlFor="device-location">
              Location
            </label>
            <p className={styles.fieldHelp}>Optional — helps tell your doorbells apart</p>
            <input
              id="device-location"
              className={styles.textInput}
              type="text"
              maxLength={40}
              placeholder="e.g. Front porch"
              value={device.location}
              onChange={(e) => patch({ location: e.target.value })}
              onBlur={flashSaved}
            />
          </div>
        </>
      ) : (
        <div className={styles.fieldGroup}>
          <div className={styles.aboutRow}>
            <span>Name</span>
            <span>{device.name}</span>
          </div>
          {device.location && (
            <div className={styles.aboutRow}>
              <span>Location</span>
              <span>{device.location}</span>
            </div>
          )}
          <p className={styles.note}>Shared with you — only the owner can change these.</p>
        </div>
      )}

      <p className={styles.sectionLabel}>Your notifications</p>
      <PushSection compact />
      <div className={styles.fieldGroup}>
        <p className={styles.fieldHelp}>
          What this doorbell alerts you about. Just for you — others it's shared with choose their
          own.
        </p>
        <div className={styles.toggleRow}>
          <div className={styles.toggleText}>
            <p className={styles.fieldLabel}>Someone rings the bell</p>
          </div>
          <Toggle
            label="Doorbell ring notifications"
            checked={device.notifRing}
            onChange={(notifRing) => commitPrefsAndFlash({ notifRing })}
          />
        </div>
        <div className={styles.toggleRow}>
          <div className={styles.toggleText}>
            <p className={styles.fieldLabel}>Motion at the door</p>
            <p className={styles.toggleHelp}>At most one alert every few minutes</p>
          </div>
          <Toggle
            label="Motion notifications"
            checked={device.notifMotion}
            onChange={(notifMotion) => commitPrefsAndFlash({ notifMotion })}
          />
        </div>
      </div>

      <DeviceSharing device={device} />

      {device.provisioned && <WifiSection device={device} canManage={isOwner} />}
      {device.provisioned && <SoftwareSection device={device} canManage={isOwner} />}

      <p className={styles.sectionLabel}>About this doorbell</p>
      <div className={styles.fieldGroup}>
        <div className={styles.aboutRow}>
          <span>Status</span>
          <span>{statusLabel(device.status)}</span>
        </div>
        {device.provisioned && lastOnline && (
          <div className={styles.aboutRow}>
            <span>Last online</span>
            <span>{lastOnline}</span>
          </div>
        )}
        {device.provisioned && (
          <div className={styles.aboutRow}>
            <span>Software</span>
            <span>{version || 'Factory version'}</span>
          </div>
        )}
        {device.deviceId && (
          <div className={styles.aboutRow}>
            <span>Device ID</span>
            <span className={styles.mono}>{device.deviceId}</span>
          </div>
        )}
        <div className={styles.aboutRow}>
          <span>Added</span>
          <span>{formatDate(device.claimedAt || device.createdAt)}</span>
        </div>
        <div className={styles.aboutRow}>
          <span>You are</span>
          <span>{isOwner ? 'The owner' : 'A member'}</span>
        </div>
      </div>

      <DeviceDanger device={device} />

      <p className={styles.accountLink}>
        Your name, password and theme are in <Link to="/account">Account settings</Link>.
      </p>

      <p className={`${styles.saveNote} ${showSaved ? styles.show : ''}`} aria-live="polite">
        {showSaved ? 'Saved' : ''}
      </p>
    </section>
  );
}
