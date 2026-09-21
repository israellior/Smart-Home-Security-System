import { Link, Outlet, useOutletContext, useParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useDevices } from '../context/DevicesContext';
import { useDeviceSignal } from '../hooks/useDeviceSignal';
import { TabNav } from './TabNav';
import styles from './DeviceLayout.module.css';

/**
 * Wraps the three per-device views. Resolves :deviceId against the list
 * already in DevicesContext rather than fetching it again, and hands the
 * resolved device down through the router's outlet context so Overview,
 * Activity and Settings don't each have to look it up.
 *
 * Keeping the device in the URL rather than an "activeDevice" in state
 * is what makes a specific doorbell linkable and the back button work.
 */
export function DeviceLayout() {
  const { deviceId } = useParams();
  const { token } = useAuth();
  const { devices, loading, error } = useDevices();

  // One socket per doorbell, opened here rather than in each page, so
  // switching between Overview and Activity doesn't tear a connection
  // down and build another. Called above the early returns below because
  // hooks cannot be conditional - deviceId comes from the URL, so it is
  // available whether or not the device has loaded yet.
  const signal = useDeviceSignal(token, deviceId);

  if (loading) return <p className={styles.notice}>Loading…</p>;
  if (error) return <p className={styles.error}>{error}</p>;

  const device = devices.find((d) => d._id === deviceId);

  // Reachable by an ordinary route: a bookmarked device you've since
  // left, or one the owner deleted. Better than a blank screen.
  if (!device) {
    return (
      <div className={styles.notFound}>
        <p>That doorbell isn&apos;t on your list</p>
        <p>It may have been deleted, or you may have left it.</p>
        <Link className={styles.backLink} to="/">
          All doorbells
        </Link>
      </div>
    );
  }

  // The socket outranks the device list for presence, because the list
  // was fetched once and the socket is watching. Until it has an opinion
  // (null) the stored value stands, so the status doesn't flicker
  // through "not connected" on every page load.
  const live =
    signal.connected === null ? device : { ...device, connected: signal.connected };

  return (
    <>
      <div className={styles.crumb}>
        <Link className={styles.back} to="/">
          ‹ All doorbells
        </Link>
        {device.role === 'member' && <span className={styles.roleTag}>Shared with you</span>}
      </div>
      <TabNav deviceId={deviceId} />
      <Outlet context={{ device: live, signal }} />
    </>
  );
}

/**
 * The device resolved by DeviceLayout above, with live presence folded
 * in. Lives here rather than in a context of its own because the router
 * is already carrying the value - this just gives it a name so pages read
 * `useDevice()` instead of the anonymous `useOutletContext()`.
 */
export function useDevice() {
  return useOutletContext().device;
}

/**
 * The live socket for this doorbell: `connected`, and `lastEvent` for
 * pages that want events as they happen rather than as they were when
 * the page loaded.
 *
 * Separate from useDevice() so the pages that only render a device carry
 * on unchanged - only the one that wants live updates has to know a
 * socket exists.
 */
export function useDeviceLive() {
  return useOutletContext().signal;
}
