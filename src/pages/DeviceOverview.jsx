import { Link } from 'react-router-dom';
import { useDevice } from '../components/DeviceLayout';
import { GlowIcon } from '../components/GlowIcon';
import styles from './DeviceOverview.module.css';

/**
 * One doorbell's headline view - what Home used to be, back when there
 * was only ever one. The device comes from DeviceLayout via the router's
 * outlet context, so this page never fetches or looks anything up.
 */
export function DeviceOverview() {
  const device = useDevice();

  return (
    <section>
      <div className={styles.hero}>
        <div className={styles.glowRing}>
          <GlowIcon />
        </div>
        <p className={styles.deviceName}>{device.name}</p>
        <p className={styles.deviceState}>
          {device.connected ? 'Connected and watching' : 'No doorbell connected yet'}
        </p>
        {device.location && <p className={styles.deviceLocation}>{device.location}</p>}
        <button className={styles.liveBtn} disabled>
          View live — coming soon
        </button>
        <p className={styles.heroNote}>
          Live video and two-way talk turn on automatically once your camera and speaker are
          wired up. For now, you can still set up the basics.
        </p>
      </div>

      <p className={styles.sectionLabel}>Get started</p>
      <Link className={styles.settingsLink} to={`/devices/${device._id}/settings`}>
        Set up this doorbell
      </Link>
    </section>
  );
}
