import { Link } from 'react-router-dom';
import { useSettings } from '../context/SettingsContext';
import { GlowIcon } from '../components/GlowIcon';
import styles from './Home.module.css';

export function Home() {
  const { settings } = useSettings();

  return (
    <section>
      <div className={styles.hero}>
        <div className={styles.glowRing}>
          <GlowIcon />
        </div>
        <p className={styles.deviceName}>{settings.name || 'Front Door'}</p>
        <p className={styles.deviceState}>No doorbell connected yet</p>
        <button className={styles.liveBtn} disabled>
          View live — coming soon
        </button>
        <p className={styles.heroNote}>
          Live video and two-way talk turn on automatically once your camera and speaker are
          wired up. For now, you can still set up the basics below.
        </p>
      </div>

      <p className={styles.sectionLabel}>Get started</p>
      <Link className={styles.addDevice} to="/settings">
        Connect your doorbell
      </Link>
    </section>
  );
}
