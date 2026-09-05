import { createContext, useCallback, useContext, useEffect, useReducer } from 'react';
import { api } from '../api/client';

const AuthContext = createContext(null);

function readStoredToken() {
  try {
    return localStorage.getItem('porchlight-token');
  } catch (err) {
    return null;
  }
}

function writeStoredToken(token) {
  try {
    if (token) localStorage.setItem('porchlight-token', token);
    else localStorage.removeItem('porchlight-token');
  } catch (err) {
    // Storage unavailable - the session just won't survive a refresh.
  }
}

// Logged out and never-logged-in are the same state, so they share one
// object. Returning the identical reference also means React can skip a
// re-render when we're already anonymous - safe only because nothing
// ever mutates state in place.
const ANONYMOUS = { status: 'anonymous', token: null, user: null };

/**
 * A stored token is *unverified* until GET /api/auth/me says otherwise,
 * which is why the initial status is 'checking' rather than
 * 'authenticated' - an expired or tampered token gets discarded instead
 * of silently "logging in".
 */
function init() {
  const token = readStoredToken();
  return token ? { status: 'checking', token, user: null } : ANONYMOUS;
}

/**
 * Pure - no fetches, no localStorage, no navigation. That's what makes
 * it testable in isolation ("from 'checking', a verification_failed
 * action must produce ANONYMOUS") and what keeps it safe under
 * StrictMode, which deliberately double-invokes reducers in dev to
 * surface side effects hiding in here.
 *
 * The three facts auth has to track - is there a token, do we know whose
 * it is, are we still finding out - were never independent of each
 * other. Collapsing them into one status plus its payload means the
 * combinations that used to be reachable by accident can't be written
 * down: there is no way to produce a token that passed the check but
 * carries no user.
 */
function authReducer(state, action) {
  switch (action.type) {
    case 'verified':
      // Keeps the token already in state - this action only resolves
      // *who* it belongs to.
      return { status: 'authenticated', token: state.token, user: action.user };

    case 'verification_failed':
      return ANONYMOUS;

    case 'signed_in':
      // Login and register both hand back the token and the user
      // together, so there is nothing left to look up afterwards.
      return { status: 'authenticated', token: action.token, user: action.user };

    case 'signed_out':
      // Same resulting state as verification_failed, deliberately a
      // different action: one is the user leaving, the other is a
      // session expiring, and a log of these should tell them apart.
      return ANONYMOUS;

    default:
      throw new Error(`Unknown auth action: ${action.type}`);
  }
}

/**
 * Owns the JWT and the current user. Every transition goes through
 * authReducer, so the whole sequence is visible from one place - drop a
 * console.log in the reducer and you get the entire session lifecycle
 * in order, rather than reconstructing it from scattered setState calls.
 */
export function AuthProvider({ children }) {
  const [state, dispatch] = useReducer(authReducer, undefined, init);
  const { status, token, user } = state;

  // Storage mirrors the token, whichever action changed it. Doing this
  // as an effect rather than inside each transition keeps the reducer
  // pure, and means a future action can't forget to keep the two in
  // sync. Writing the same value back on mount is a harmless no-op.
  useEffect(() => {
    writeStoredToken(token);
  }, [token]);

  useEffect(() => {
    // Only a token restored from a previous visit needs checking. After
    // signed_in the status is already 'authenticated', so this never
    // re-fetches a user the login response just handed us.
    if (status !== 'checking') return undefined;

    let cancelled = false;

    api
      .me(token)
      .then(({ user }) => {
        if (cancelled) return;
        // A 200 with no user is not a valid session. Treating it as a
        // failure is what stops "authenticated but nobody's home" - the
        // state that used to slip past ProtectedRoute and then hide the
        // logout button, stranding you in a session you couldn't leave.
        if (user) dispatch({ type: 'verified', user });
        else dispatch({ type: 'verification_failed' });
      })
      .catch(() => {
        if (!cancelled) dispatch({ type: 'verification_failed' });
      });

    return () => {
      cancelled = true;
    };
  }, [status, token]);

  const login = useCallback(async (email, password) => {
    const { token, user } = await api.login({ email, password });
    dispatch({ type: 'signed_in', token, user });
  }, []);

  const register = useCallback(async (name, email, password) => {
    const { token, user } = await api.register({ name, email, password });
    dispatch({ type: 'signed_in', token, user });
  }, []);

  const logout = useCallback(() => {
    dispatch({ type: 'signed_out' });
  }, []);

  // `loading` is derived, not stored - it was only ever "we have a token
  // we haven't checked yet". Exposed under the old name so consumers
  // don't all have to change at once; `status` is the better thing to
  // read in new code.
  const loading = status === 'checking';

  return (
    <AuthContext.Provider value={{ status, token, user, loading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
