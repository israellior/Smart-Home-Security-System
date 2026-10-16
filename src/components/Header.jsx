import { Link, NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { ThemeToggle } from './ThemeToggle';
import styles from './Header.module.css';

/**
 * Global chrome only. The connected/not-connected pill used to live here
 * back when there was exactly one doorbell; now that an account can hold
 * several, that status belongs to a device rather than to the app - it's
 * on each row of the Home list and on the device overview.
 *
 * The round initial is the way to Account settings, which is also where
 * logging out lives now.
 */
export function Header() {
  const { user } = useAuth();
  const initial = (user?.name || user?.email || '?').trim().charAt(0).toUpperCase();

  return (
    <header className={styles.header}>
      <Link to="/" className={styles.wordmark}>
        Porchlight
      </Link>
      <div className={styles.right}>
        <ThemeToggle />
        {user && (
          <NavLink
            to="/account"
            className={({ isActive }) => `${styles.avatar} ${isActive ? styles.active : ''}`}
            aria-label="Account settings"
            title={`${user.name} · Account settings`}
          >
            {initial}
          </NavLink>
        )}
      </div>
    </header>
  );
}
