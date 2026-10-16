import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

/**
 * Where to go once signed in: the page ProtectedRoute turned you away
 * from, or home. Only ever a path inside this app - it comes from router
 * state, never from the URL, so a crafted link cannot use the login page
 * to send someone elsewhere.
 */
export function returnPath(state) {
  const from = state?.from;
  if (!from?.pathname) return '/';
  return `${from.pathname}${from.search || ''}${from.hash || ''}`;
}

/**
 * The mirror of ProtectedRoute, for /login, /register and
 * /forgot-password: once you are signed in they have nothing to offer,
 * so you go on to where you were headed.
 *
 * This is also what moves you on *after* logging in or registering - the
 * forms only change the auth state, and this reacts to it. One place
 * decides where a new session lands.
 *
 * A stored token that is still being checked shows the form rather than
 * a blank page: most of the time the token turns out to be stale, and
 * when it is good the redirect follows a moment later.
 */
export function GuestRoute() {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'authenticated') {
    return <Navigate to={returnPath(location.state)} replace />;
  }

  return <Outlet />;
}
