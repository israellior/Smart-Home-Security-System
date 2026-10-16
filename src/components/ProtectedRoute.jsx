import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import styles from './ProtectedRoute.module.css';

/**
 * Gate for the "real app" routes (Home/Activity/Settings). Renders
 * nothing but a loading line while we're still checking a stored
 * token against the server, then either renders the matched child
 * route (via <Outlet/>) or bounces to /login.
 *
 * The bounce carries where you were going, so a link to one doorbell's
 * activity still lands there once you've logged in - see GuestRoute.
 */
export function ProtectedRoute() {
  const { token, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return <p className={styles.loading}>Loading…</p>;
  }

  if (!token) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return <Outlet />;
}
