import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from './AuthContext';

const SettingsContext = createContext(null);

const DEFAULTS = {
  name: 'Front Door',
  location: '',
  sensitivity: 'standard',
  notifMotion: true,
  notifRing: true,
  notifDaily: false,
  connected: false
};

/**
 * Single source of truth for the logged-in user's doorbell settings,
 * now backed by the real API instead of localStorage. On mount, it
 * fetches the user's device list; if they don't have one yet (first
 * login), it creates one with defaults, mirroring what "Connect your
 * doorbell" used to do locally. Every update is applied optimistically
 * to local state immediately, then confirmed against the server -
 * pages calling useSettings() don't need to know any of that happened.
 */
export function SettingsProvider({ children }) {
  const { token } = useAuth();
  const [deviceId, setDeviceId] = useState(null);
  const [settings, setSettings] = useState(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const { devices } = await api.listDevices(token);
        let device = devices[0];
        if (!device) {
          const created = await api.createDevice(token, {});
          device = created.device;
        }
        if (!cancelled) {
          setDeviceId(device._id);
          setSettings({ ...DEFAULTS, ...device });
        }
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    if (token) load();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const updateSettings = useCallback(
    async (patch) => {
      setSettings((prev) => ({ ...prev, ...patch })); // optimistic, so typing feels instant
      if (!deviceId) return;
      try {
        const { device } = await api.updateDevice(token, deviceId, patch);
        setSettings((prev) => ({ ...prev, ...device }));
      } catch (err) {
        setError(err.message);
      }
    },
    [deviceId, token]
  );

  return (
    <SettingsContext.Provider value={{ settings, updateSettings, deviceId, loading, error }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used within a SettingsProvider');
  return ctx;
}
