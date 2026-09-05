import { useEffect, useRef, useState } from 'react';
import { useDevices } from '../context/DevicesContext';
import { useDevice } from '../components/DeviceLayout';
import { Toggle } from '../components/Toggle';
import { SegmentedControl } from '../components/SegmentedControl';
import { DeviceSharing } from '../components/DeviceSharing';
import styles from './Settings.module.css';

const SENSITIVITY_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'standard', label: 'Standard' },
  { value: 'high', label: 'High' }
];

export function Settings() {
  const device = useDevice();
  const { updateDevice } = useDevices();
  const [showSaved, setShowSaved] = useState(false);
  const saveTimer = useRef(null);

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

  const patch = (fields) => updateDevice(device._id, fields);

  // Discrete choices (toggle, segmented control) flash "Saved" the moment
  // they change. Text fields only flash on blur, so it doesn't flicker
  // on every keystroke while still updating the device list live.
  const commitAndFlash = (fields) => {
    patch(fields);
    flashSaved();
  };

  return (
    <section>
      <p className={styles.sectionLabel}>Device</p>

      <div className={styles.fieldGroup}>
        <p className={styles.fieldLabel}>Name</p>
        <p className={styles.fieldHelp}>Shown in your list of doorbells</p>
        <input
          className={styles.textInput}
          type="text"
          maxLength={40}
          value={device.name}
          onChange={(e) => patch({ name: e.target.value })}
          onBlur={flashSaved}
        />
      </div>

      <div className={styles.fieldGroup}>
        <p className={styles.fieldLabel}>Location</p>
        <p className={styles.fieldHelp}>
          Optional — helps tell your doorbells apart
        </p>
        <input
          className={styles.textInput}
          type="text"
          maxLength={40}
          placeholder="e.g. Front porch"
          value={device.location}
          onChange={(e) => patch({ location: e.target.value })}
          onBlur={flashSaved}
        />
      </div>

      <p className={styles.sectionLabel}>Motion sensitivity</p>
      <div className={styles.fieldGroup}>
        <p className={styles.fieldHelp}>How much movement it takes to trigger an alert</p>
        <SegmentedControl
          options={SENSITIVITY_OPTIONS}
          value={device.sensitivity}
          onChange={(sensitivity) => commitAndFlash({ sensitivity })}
        />
      </div>

      <p className={styles.sectionLabel}>Notifications</p>
      <div className={styles.fieldGroup}>
        <div className={styles.toggleRow}>
          <div className={styles.toggleText}>
            <p className={styles.fieldLabel}>Motion detected</p>
          </div>
          <Toggle
            label="Motion detected notifications"
            checked={device.notifMotion}
            onChange={(notifMotion) => commitAndFlash({ notifMotion })}
          />
        </div>
        <div className={styles.toggleRow}>
          <div className={styles.toggleText}>
            <p className={styles.fieldLabel}>Someone rings the bell</p>
          </div>
          <Toggle
            label="Doorbell ring notifications"
            checked={device.notifRing}
            onChange={(notifRing) => commitAndFlash({ notifRing })}
          />
        </div>
        <div className={styles.toggleRow}>
          <div className={styles.toggleText}>
            <p className={styles.fieldLabel}>Daily summary</p>
          </div>
          <Toggle
            label="Daily summary notifications"
            checked={device.notifDaily}
            onChange={(notifDaily) => commitAndFlash({ notifDaily })}
          />
        </div>
      </div>

      <DeviceSharing device={device} />

      <p className={styles.sectionLabel}>About</p>
      <div className={styles.fieldGroup}>
        <div className={styles.aboutRow}>
          <span>Firmware</span>
          <span>Not connected</span>
        </div>
        <div className={styles.aboutRow}>
          <span>App version</span>
          <span>0.2 — pre-hardware</span>
        </div>
      </div>

      <p className={`${styles.saveNote} ${showSaved ? styles.show : ''}`}>Saved</p>
    </section>
  );
}
