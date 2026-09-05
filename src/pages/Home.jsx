import { Link } from 'react-router-dom';
import { useDevices } from '../context/DevicesContext';
import { GlowIcon } from '../components/GlowIcon';
import styles from './Home.module.css';

/**
 * The list of doorbells this account can see - owned and shared alike.
 * Tapping one opens its overview/activity/settings; the hero that used
 * to live here moved to DeviceOverview, since it describes one device
 * rather than the account.
 */
export function Home() {
  const { devices, loading, error } = useDevices();

  const hasDevices = devices.length > 0;

  return (
    <section>
      <p className={styles.sectionLabel}>Your doorbells</p>

      {loading && <p className={styles.loading}>Loading…</p>}

      {!loading && error && <p className={styles.error}>{error}</p>}

      {!loading && !error && !hasDevices && (
        <div className={styles.empty}>
          <div className={styles.glowRing}>
            <GlowIcon />
          </div>
          <p>No doorbells yet</p>
          <p>
            Add your first one to start setting it up — or join one someone else has already
            set up, with the code they give you.
          </p>
        </div>
      )}

      {!loading &&
        !error &&
        devices.map((device) => (
          <Link key={device._id} className={styles.deviceRow} to={`/devices/${device._id}`}>
            <span
              className={`${styles.statusDot} ${device.connected ? styles.connected : ''}`}
            />
            <span className={styles.deviceText}>
              <span className={styles.deviceName}>{device.name}</span>
              <span className={styles.deviceMeta}>
                {device.connected ? 'Connected' : 'Not connected'}
                {device.location && ` · ${device.location}`}
                {device.role === 'member' && ' · Shared with you'}
              </span>
            </span>
            <span className={styles.chevron} aria-hidden="true">
              ›
            </span>
          </Link>
        ))}

      {!loading && !error && (
        <Link className={styles.addDevice} to="/devices/new">
          Add a doorbell
        </Link>
      )}
    </section>
  );
}
