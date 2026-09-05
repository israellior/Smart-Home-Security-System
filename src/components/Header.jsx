import { Link } from 'react-router-dom';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import styles from './Header.module.css';

/**
 * Global chrome only. The connected/not-connected pill used to live here
 * back when there was exactly one doorbell; now that an account can hold
 * several, that status belongs to a device rather than to the app - it's
 * on each row of the Home list and on the device overview.
 */
export function Header() {
  const { resolvedTheme, toggleTheme } = useTheme();
  const { user, logout } = useAuth();
  const isDark = resolvedTheme === 'dark';

  return (
    <header className={styles.header}>
      <Link to="/" className={styles.wordmark}>
        Porchlight
      </Link>
      <div className={styles.right}>
        <button
          className={styles.themeToggle}
          onClick={toggleTheme}
          aria-label="Toggle light and dark theme"
          title="Toggle theme"
        >
          {isDark ? '☾' : '◐'}
        </button>
        {user && (
          <button className={styles.logoutBtn} onClick={logout} title={user.email}>
            Log out
          </button>
        )}
      </div>
    </header>
  );
}
