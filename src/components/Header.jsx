import { Link } from 'react-router-dom';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { useSettings } from '../context/SettingsContext';
import styles from './Header.module.css';

export function Header() {
  const { theme, toggleTheme } = useTheme();
  const { user, logout } = useAuth();
  const { settings } = useSettings();
  const isDark = theme === 'dark' || (!theme && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  const connected = settings.connected;

  return (
    <header className={styles.header}>
      <Link to="/" className={styles.wordmark}>
        Porchlight
      </Link>
      <div className={styles.right}>
        <div className={styles.statusPill}>
          <span className={`${styles.statusDot} ${connected ? styles.connected : ''}`} />
          <span>{connected ? 'Connected' : 'Not connected'}</span>
        </div>
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
