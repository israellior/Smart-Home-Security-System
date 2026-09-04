import styles from './Toggle.module.css';

/**
 * Generic on/off switch. Fully controlled - the parent owns the
 * checked state, this component just renders it and reports changes.
 * Used for every notification row on the Settings page.
 */
export function Toggle({ checked, onChange, label }) {
  return (
    <label className={styles.switch}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={label}
      />
      <span className={styles.track} />
    </label>
  );
}
