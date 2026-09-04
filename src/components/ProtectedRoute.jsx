import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

/**
 * Gate for the "real app" routes (Home/Activity/Settings). Renders
 * nothing but a loading line while we're still checking a stored
 * token against the server, then either renders the matched child
 * route (via <Outlet/>) or bounces to /login.
 */
export function ProtectedRoute() {
  const { token, loading } = useAuth();

  if (loading) {
    return <p style={{ padding: '40px 0', textAlign: 'center', color: 'var(--muted)' }}>Loading…</p>;
  }

  if (!token) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}
