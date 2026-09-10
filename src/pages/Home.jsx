import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useDevices } from '../context/DevicesContext';
import { GlowIcon } from '../components/GlowIcon';
import styles from './Home.module.css';

/**
 * The themes are "day porch" and "evening porch" rather than a generic
 * light/dark pair, so the greeting follows the same clock the look does.
 */
function greetingFor(hour) {
  if (hour < 5) return 'Still up';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

// "Ada Lovelace" -> "Ada". A greeting uses the name someone is called,
// not the one on their account.
function firstName(name) {
  const first = String(name || '').trim().split(/\s+/)[0];
  return first || 'there';
}

/**
 * The list of doorbells this account can see - owned and shared alike.
 * Tapping one opens its overview/activity/settings; the hero that used
 * to live here moved to DeviceOverview, since it describes one device
 * rather than the account.
 */
export function Home() {
  const { user } = useAuth();
  const { devices, loading, error } = useDevices();

  const hasDevices = devices.length > 0;
  const totalNew = devices.reduce((sum, device) => sum + (device.newEventCount || 0), 0);

  // Computed at render rather than stored - it's derived from the clock
  // and the device list, and both are already here.
  const greeting = `${greetingFor(new Date().getHours())}, ${firstName(user?.name)}`;

  let summary = null;
  if (!loading && !error && hasDevices) {
    summary =
      totalNew > 0
        ? `${totalNew} new ${totalNew === 1 ? 'event' : 'events'} since you last looked`
        : `All quiet at your ${devices.length === 1 ? 'doorbell' : `${devices.length} doorbells`}`;
  }

  return (
    <section>
      <div className={styles.greeting}>
        <h1 className={styles.greetingLine}>{greeting}</h1>
        {summary && (
          <p className={`${styles.greetingSub} ${totalNew > 0 ? styles.hasNew : ''}`}>{summary}</p>
        )}
      </div>

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
            {device.newEventCount > 0 && (
              <span
                className={styles.newBadge}
                title={`${device.newEventCount} new since you last looked`}
              >
                {device.newEventCount > 99 ? '99+' : device.newEventCount}
              </span>
            )}
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
