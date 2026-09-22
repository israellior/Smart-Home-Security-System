import { lazy, Suspense } from 'react';
import { Link } from 'react-router-dom';
import { useDevice } from '../components/DeviceLayout';
import { GlowIcon } from '../components/GlowIcon';
import styles from './DeviceOverview.module.css';

/**
 * Split out, because the LiveKit client is roughly three times the size
 * of the entire rest of this app. Bundled inline it would be downloaded
 * by everyone opening any page, to serve the one thing they may never
 * press. Loaded this way it arrives with the component that needs it.
 */
const LiveView = lazy(() =>
  import('../components/LiveView').then((m) => ({ default: m.LiveView }))
);

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

        {device.provisioned ? (
          <Suspense fallback={<p className={styles.heroNote}>Loading live view…</p>}>
            <LiveView device={device} />
          </Suspense>
        ) : (
          <>
            <button className={styles.liveBtn} disabled>
              View live
            </button>
            <p className={styles.heroNote}>
              This doorbell has no hardware paired with it yet. Live video and two-way talk turn
              on once a camera is set up and connected.
            </p>
          </>
        )}
      </div>

      <p className={styles.sectionLabel}>Get started</p>
      <Link className={styles.settingsLink} to={`/devices/${device._id}/settings`}>
        Set up this doorbell
      </Link>
    </section>
  );
}
