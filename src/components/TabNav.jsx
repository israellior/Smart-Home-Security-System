import { NavLink } from 'react-router-dom';
import styles from './TabNav.module.css';

/**
 * The three views of one doorbell. Scoped to a device rather than global
 * now that an account can hold several - the tabs sit inside
 * /devices/:deviceId, so each one is still a first-class, linkable,
 * back-button-friendly URL rather than a JS-driven panel swap.
 *
 * Built per render because the hrefs depend on which device is open;
 * there's no module-level constant to hoist any more.
 */
export function TabNav({ deviceId }) {
  const tabs = [
    { to: `/devices/${deviceId}`, label: 'Overview', end: true },
    { to: `/devices/${deviceId}/activity`, label: 'Activity' },
    { to: `/devices/${deviceId}/settings`, label: 'Settings' }
  ];

  return (
    <nav className={styles.tabs}>
      {tabs.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end={tab.end}
          className={({ isActive }) => `${styles.tab} ${isActive ? styles.active : ''}`}
        >
          {tab.label}
        </NavLink>
      ))}
    </nav>
  );
}
