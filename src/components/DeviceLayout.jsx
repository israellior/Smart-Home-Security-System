import { Link, Outlet, useOutletContext, useParams } from 'react-router-dom';
import { useDevices } from '../context/DevicesContext';
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
  const { devices, loading, error } = useDevices();

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

  return (
    <>
      <div className={styles.crumb}>
        <Link className={styles.back} to="/">
          ‹ All doorbells
        </Link>
        {device.role === 'member' && <span className={styles.roleTag}>Shared with you</span>}
      </div>
      <TabNav deviceId={deviceId} />
      <Outlet context={device} />
    </>
  );
}

/**
 * The device resolved by DeviceLayout above. Lives here rather than in a
 * context of its own because the router is already carrying the value -
 * this just gives it a name so pages read `useDevice()` instead of the
 * anonymous `useOutletContext()`.
 */
export function useDevice() {
  return useOutletContext();
}
