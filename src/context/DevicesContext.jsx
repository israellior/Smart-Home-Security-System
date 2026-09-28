import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
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

  // Whether the list has ever arrived. Guards refresh() below, so the
  // screens that ask for fresh numbers on arrival don't fire a second
  // identical request alongside the first load.
  const loadedOnce = useRef(false);

  useEffect(() => {
    if (!token) return undefined;

    let cancelled = false;
    setLoading(true);
    setError(null);

    async function load() {
      try {
        const { devices } = await api.listDevices(token);
        if (!cancelled) {
          setDevices(devices);
          loadedOnce.current = true;
        }
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

  /**
   * Re-reads the list, quietly.
   *
   * The unread counts are the one part of a device that goes stale on its
   * own: a doorbell you are not looking at has no socket into this tab,
   * so nothing can tell us it rang. Without this the counts would be
   * frozen at whatever they were when you logged in, which for a tab left
   * open all day is most of the day.
   *
   * No loading state and no error state on purpose. This runs on a screen
   * that already has a list to show, so a spinner over it would be a
   * step backwards, and a failure just means the numbers stay as they
   * were until the next attempt - which is what they already are.
   */
  const refresh = useCallback(async () => {
    if (!token || !loadedOnce.current) return;
    try {
      const { devices } = await api.listDevices(token);
      setDevices(devices);
    } catch (err) {
      console.warn('Could not refresh doorbells:', err.message);
    }
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

  /**
   * Folds a device the server just handed back into the list, whether it
   * is new to us or one we already held.
   *
   * Both code paths below are idempotent server-side, so either can return
   * a doorbell that is already on the list - a double-tapped button, a
   * retried request - and appending would leave two rows for one doorbell.
   */
  const absorbDevice = useCallback((device) => {
    setDevices((prev) =>
      prev.some((d) => d._id === device._id)
        ? prev.map((d) => (d._id === device._id ? device : d))
        : [...prev, device]
    );
    return device;
  }, []);

  /**
   * Claim a new doorbell with the one-time code on the unit. This is the
   * only way to become the owner of hardware, and the code is spent by
   * doing it.
   */
  const claimDevice = useCallback(
    async (claimCode) => {
      const { device } = await api.claimDevice(token, claimCode);
      return absorbDevice(device);
    },
    [token, absorbDevice]
  );

  /** Join one somebody else owns, with the code they gave you. */
  const joinDevice = useCallback(
    async (shareCode) => {
      const { device } = await api.joinDevice(token, shareCode);
      return absorbDevice(device);
    },
    [token, absorbDevice]
  );

  /**
   * Mint or rotate this doorbell's share code, and revoke it.
   *
   * Not optimistic, unlike the preference writes above: the point of the
   * screen is to read a code off it, and a code that turned out not to
   * exist would be one somebody had already read aloud.
   */
  const createShareCode = useCallback(
    async (id) => {
      const { device } = await api.createShareCode(token, id);
      return absorbDevice(device);
    },
    [token, absorbDevice]
  );

  const revokeShareCode = useCallback(
    async (id) => {
      const { device } = await api.revokeShareCode(token, id);
      return absorbDevice(device);
    },
    [token, absorbDevice]
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

  /**
   * Which doorbell's activity list is open right now, if any.
   *
   * A ref rather than state: nothing renders from it, and making it state
   * would re-render every consumer of this context each time someone
   * opened or left the Activity page.
   */
  const readingRef = useRef(null);

  /**
   * "I am looking at this doorbell's activity list." Returns its own
   * undo, so a caller can hand it straight to useEffect.
   */
  const beginReading = useCallback((id) => {
    readingRef.current = id;
    return () => {
      // Guarded, because mounting the next page can run before the last
      // one's cleanup - clearing unconditionally would wipe a claim that
      // belongs to somebody else.
      if (readingRef.current === id) readingRef.current = null;
    };
  }, []);

  /**
   * An alert arrived over the socket while the app is open.
   *
   * Without this the counts are whatever the server said on the one
   * fetch at login: a doorbell could ring with the app open and every
   * badge would carry on reading zero until a reload. The socket is
   * already there - this is just the count listening to it.
   *
   * Counting by event id, not by frame: a motion upgraded to a ring is
   * pushed twice as the *same* event with a different kind, which is one
   * thing to go and look at, not two. That matches the server, which
   * counts documents.
   *
   * The set of ids seen grows for as long as the tab is open. A busy
   * doorbell left open for a month is a few thousand short strings, so
   * it is left to be collected with the page rather than trimmed.
   */
  const notedRef = useRef(new Set());

  const noteEvent = useCallback(
    (event) => {
      const id = event?.device;
      if (!id || !event._id || notedRef.current.has(event._id)) return;
      notedRef.current.add(event._id);

      // Somebody has this doorbell's activity list open, so the alert is
      // already on their screen - it was never unread. Move the watermark
      // instead of raising a badge over the page they are reading it on.
      // Doing it here rather than in the Activity page is what keeps the
      // two from racing: one place decides, so there is no order to get
      // wrong.
      if (readingRef.current === id) {
        markSeen(id);
        return;
      }

      setDevices((prev) =>
        prev.map((d) =>
          d._id === id ? { ...d, newEventCount: (d.newEventCount || 0) + 1 } : d
        )
      );
    },
    [markSeen]
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
        claimDevice,
        joinDevice,
        createShareCode,
        revokeShareCode,
        updateDevice,
        updatePreferences,
        refresh,
        markSeen,
        beginReading,
        noteEvent,
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
