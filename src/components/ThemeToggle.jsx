import { useTheme } from '../context/ThemeContext';
import styles from './ThemeToggle.module.css';

/**
 * The day/evening switch. Its own component because it sits in two
 * places now - the header of the app, and the top of the logged-out
 * pages, which have no header.
 */
export function ThemeToggle() {
  const { resolvedTheme, toggleTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  return (
    <button
      type="button"
      className={styles.toggle}
      onClick={toggleTheme}
      aria-label="Toggle light and dark theme"
      title="Toggle theme"
    >
      {isDark ? '☾' : '◐'}
    </button>
  );
}
