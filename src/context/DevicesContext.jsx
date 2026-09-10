import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from './AuthContext';

const DevicesContext = createContext(null);

/**
 * Every doorbell the logged-in user can see, each carrying the `role`
 * they hold on it ('owner' or 'member').
 *
 * This replaces the old SettingsContext, which assumed exactly one
 * device and created it silently on first load if none existed. That
 * auto-create was a check-then-act race - under StrictMode both effect
 * runs saw an empty list and both POSTed, so new accounts really did end
 * up with two identical doorbells. Devices are now added deliberately,
 * so there is nothing left to race on.
 */
export function DevicesProvider({ children }) {
  const { token, user } = useAuth();
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!token) return undefined;

    let cancelled = false;
    setLoading(true);
    setError(null);

    async function load() {
      try {
        const { devices } = await api.listDevices(token);
        if (!cancelled) setDevices(devices);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // Each mutation folds the server's response back into the list rather
  // than refetching everything - the API already returns the updated
  // device, so a second round trip would only add latency.
  const addDevice = useCallback(
    async (payload) => {
      const { device } = await api.createDevice(token, payload);
      setDevices((prev) => [...prev, device]);
      return device;
    },
    [token]
  );

  const joinDevice = useCallback(
    async (shareCode) => {
      const { device } = await api.joinDevice(token, shareCode);
      // Joining is idempotent server-side, so this may be a device we
      // already hold. Replace it rather than appending a duplicate row.
      setDevices((prev) =>
        prev.some((d) => d._id === device._id)
          ? prev.map((d) => (d._id === device._id ? device : d))
          : [...prev, device]
      );
      return device;
    },
    [token]
  );

  const updateDevice = useCallback(
    async (id, patch) => {
      setDevices((prev) => prev.map((d) => (d._id === id ? { ...d, ...patch } : d))); // optimistic
      try {
        const { device } = await api.updateDevice(token, id, patch);
        setDevices((prev) => prev.map((d) => (d._id === id ? device : d)));
      } catch (err) {
        setError(err.message);
      }
    },
    [token]
  );

  // Same optimistic shape as updateDevice, but a different endpoint: it
  // writes the caller's membership. The response still carries the whole
  // device, so consumers can't tell the difference.
  const updatePreferences = useCallback(
    async (id, prefs) => {
      setDevices((prev) => prev.map((d) => (d._id === id ? { ...d, ...prefs } : d)));
      try {
        const { device } = await api.updatePreferences(token, id, prefs);
        setDevices((prev) => prev.map((d) => (d._id === id ? device : d)));
      } catch (err) {
        setError(err.message);
      }
    },
    [token]
  );

  /**
   * Moves this device's "seen" watermark to now and clears its unread
   * count locally. Deliberately not optimistic: the badge disappearing
   * before the server agreed would be a lie if the request then failed,
   * and there's no user action waiting on it.
   */
  const markSeen = useCallback(
    async (id) => {
      try {
        const { lastSeenAt } = await api.markSeen(token, id);
        setDevices((prev) =>
          prev.map((d) => (d._id === id ? { ...d, lastSeenAt, newEventCount: 0 } : d))
        );
      } catch (err) {
        // Failing to mark as read is not worth interrupting anyone over -
        // the events are on screen either way, and the next visit retries.
        console.warn('Could not mark device as seen:', err.message);
      }
    },
    [token]
  );

  const deleteDevice = useCallback(
    async (id) => {
      await api.deleteDevice(token, id);
      setDevices((prev) => prev.filter((d) => d._id !== id));
    },
    [token]
  );

  // Leaving is the same API call as an owner removing someone, aimed at
  // yourself - which is why it needs the current user's id.
  const leaveDevice = useCallback(
    async (id) => {
      await api.removeMember(token, id, user.id);
      setDevices((prev) => prev.filter((d) => d._id !== id));
    },
    [token, user]
  );

  return (
    <DevicesContext.Provider
      value={{
        devices,
        loading,
        error,
        addDevice,
        joinDevice,
        updateDevice,
        updatePreferences,
        markSeen,
        deleteDevice,
        leaveDevice
      }}
    >
      {children}
    </DevicesContext.Provider>
  );
}

export function useDevices() {
  const ctx = useContext(DevicesContext);
  if (!ctx) throw new Error('useDevices must be used within a DevicesProvider');
  return ctx;
}
