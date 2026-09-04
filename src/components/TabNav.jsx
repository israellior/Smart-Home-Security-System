import { NavLink } from 'react-router-dom';
import styles from './TabNav.module.css';

const TABS = [
  { to: '/', label: 'Home', end: true },
  { to: '/activity', label: 'Activity' },
  { to: '/settings', label: 'Settings' }
];

/**
 * Real routes rather than JS-driven show/hide panels, so each page
 * (Home / Activity / Settings) is a first-class, linkable, back-button-
 * friendly URL. Adding a fourth tab later is just adding one entry here
 * plus a route in App.jsx.
 */
export function TabNav() {
  return (
    <nav className={styles.tabs}>
      {TABS.map((tab) => (
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
