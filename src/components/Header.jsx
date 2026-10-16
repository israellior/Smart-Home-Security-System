import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { ThemeToggle } from './ThemeToggle';
import styles from './Header.module.css';

/**
 * Global chrome only. The connected/not-connected pill used to live here
 * back when there was exactly one doorbell; now that an account can hold
 * several, that status belongs to a device rather than to the app - it's
 * on each row of the Home list and on the device overview.
 */
export function Header() {
  const { user, logout } = useAuth();

  return (
    <header className={styles.header}>
      <Link to="/" className={styles.wordmark}>
        Porchlight
      </Link>
      <div className={styles.right}>
        <ThemeToggle />
        {user && (
          <button className={styles.logoutBtn} onClick={logout} title={user.email}>
            Log out
          </button>
        )}
      </div>
    </header>
  );
}
