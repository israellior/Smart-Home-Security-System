import { createContext, useCallback, useContext, useEffect, useState } from 'react';
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

/**
 * Owns the JWT and the current user. On first load, if a token is
 * already in localStorage (from a previous visit), it's verified
 * against GET /api/auth/me rather than trusted blindly - an expired
 * or tampered token gets discarded instead of silently "logging in".
 */
export function AuthProvider({ children }) {
  const [token, setTokenState] = useState(readStoredToken);
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const setToken = (next) => {
    setTokenState(next);
    writeStoredToken(next);
  };

  useEffect(() => {
    let cancelled = false;

    if (!token) {
      setLoading(false);
      return undefined;
    }

    api
      .me(token)
      .then(({ user }) => {
        if (!cancelled) setUser(user);
      })
      .catch(() => {
        if (!cancelled) setToken(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const login = useCallback(async (email, password) => {
    const { token, user } = await api.login({ email, password });
    setToken(token);
    setUser(user);
  }, []);

  const register = useCallback(async (name, email, password) => {
    const { token, user } = await api.register({ name, email, password });
    setToken(token);
    setUser(user);
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ token, user, loading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
