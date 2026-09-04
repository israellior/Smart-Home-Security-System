import { useRef, useState } from 'react';
import { useSettings } from '../context/SettingsContext';
import { Toggle } from '../components/Toggle';
import { SegmentedControl } from '../components/SegmentedControl';
import styles from './Settings.module.css';

const SENSITIVITY_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'standard', label: 'Standard' },
  { value: 'high', label: 'High' }
];

export function Settings() {
  const { settings, updateSettings } = useSettings();
  const [showSaved, setShowSaved] = useState(false);
  const saveTimer = useRef(null);

  const flashSaved = () => {
    setShowSaved(true);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => setShowSaved(false), 1400);
  };

  // Discrete choices (toggle, segmented control) flash "Saved" the moment
  // they change. Text fields only flash on blur, so it doesn't flicker
  // on every keystroke while still updating the Home screen live.
  const commitAndFlash = (patch) => {
    updateSettings(patch);
    flashSaved();
  };

  return (
    <section>
      <p className={styles.sectionLabel}>Device</p>

      <div className={styles.fieldGroup}>
        <p className={styles.fieldLabel}>Name</p>
        <p className={styles.fieldHelp}>Shown at the top of the app</p>
        <input
          className={styles.textInput}
          type="text"
          maxLength={40}
          value={settings.name}
          onChange={(e) => updateSettings({ name: e.target.value })}
          onBlur={flashSaved}
        />
      </div>

      <div className={styles.fieldGroup}>
        <p className={styles.fieldLabel}>Location</p>
        <p className={styles.fieldHelp}>
          Optional — helps if you add more than one doorbell later
        </p>
        <input
          className={styles.textInput}
          type="text"
          maxLength={40}
          placeholder="e.g. Front porch"
          value={settings.location}
          onChange={(e) => updateSettings({ location: e.target.value })}
          onBlur={flashSaved}
        />
      </div>

      <p className={styles.sectionLabel}>Motion sensitivity</p>
      <div className={styles.fieldGroup}>
        <p className={styles.fieldHelp}>How much movement it takes to trigger an alert</p>
        <SegmentedControl
          options={SENSITIVITY_OPTIONS}
          value={settings.sensitivity}
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
            checked={settings.notifMotion}
            onChange={(notifMotion) => commitAndFlash({ notifMotion })}
          />
        </div>
        <div className={styles.toggleRow}>
          <div className={styles.toggleText}>
            <p className={styles.fieldLabel}>Someone rings the bell</p>
          </div>
          <Toggle
            label="Doorbell ring notifications"
            checked={settings.notifRing}
            onChange={(notifRing) => commitAndFlash({ notifRing })}
          />
        </div>
        <div className={styles.toggleRow}>
          <div className={styles.toggleText}>
            <p className={styles.fieldLabel}>Daily summary</p>
          </div>
          <Toggle
            label="Daily summary notifications"
            checked={settings.notifDaily}
            onChange={(notifDaily) => commitAndFlash({ notifDaily })}
          />
        </div>
      </div>

      <p className={styles.sectionLabel}>About</p>
      <div className={styles.fieldGroup}>
        <div className={styles.aboutRow}>
          <span>Firmware</span>
          <span>Not connected</span>
        </div>
        <div className={styles.aboutRow}>
          <span>App version</span>
          <span>0.1 — pre-hardware</span>
        </div>
      </div>

      <p className={`${styles.saveNote} ${showSaved ? styles.show : ''}`}>Saved</p>
    </section>
  );
}
