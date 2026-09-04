import styles from './SegmentedControl.module.css';

/**
 * A row of mutually-exclusive options (used for motion sensitivity:
 * Low / Standard / High). `options` is [{ value, label }, ...] so this
 * component can be reused anywhere else a similar picker is needed.
 */
export function SegmentedControl({ options, value, onChange }) {
  return (
    <div className={styles.segmented}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={opt.value === value ? styles.selected : ''}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
