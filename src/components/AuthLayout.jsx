import { Link } from 'react-router-dom';
import { ThemeToggle } from './ThemeToggle';
import { GlowIcon } from './GlowIcon';
import { BellIcon, CameraIcon, MicIcon } from './Icons';
import styles from './AuthLayout.module.css';

/**
 * The frame every logged-out page sits in: log in, create an account,
 * forgot password, choose a new one.
 *
 * On a wide screen it is two halves. The left one is the brand, and it is
 * always the evening palette whichever theme is showing - a porch at
 * night with its light on, which is the picture the name is. The right
 * half follows the theme like the rest of the app. On a phone the brand
 * half is dropped and only its wordmark stays, above the form.
 */
export function AuthLayout({ title, subtitle, children, footer }) {
  return (
    <div className={styles.page}>
      <aside className={styles.brand}>
        <span className={styles.brandWordmark}>Porchlight</span>

        <div className={styles.brandMiddle}>
          <div className={styles.lamp}>
            <GlowIcon />
          </div>
          <p className={styles.brandHeadline}>Know who's at the door, wherever you are.</p>
          <ul className={styles.brandPoints}>
            <li>
              <BellIcon size={18} />
              Rings and motion, the moment they happen
            </li>
            <li>
              <CameraIcon size={18} />
              Live view from your phone or laptop
            </li>
            <li>
              <MicIcon size={18} />
              Talk to whoever is there
            </li>
          </ul>
        </div>

        <span className={styles.brandFoot}>© {new Date().getFullYear()} Porchlight</span>
      </aside>

      <main className={styles.formSide}>
        <div className={styles.topBar}>
          <Link to="/login" className={styles.mobileWordmark}>
            Porchlight
          </Link>
          <ThemeToggle />
        </div>

        <div className={styles.center}>
          <div className={styles.card}>
            <div className={styles.mark} aria-hidden="true">
              <GlowIcon />
            </div>
            <h1 className={styles.title}>{title}</h1>
            {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
            {children}
          </div>
          {footer && <div className={styles.footer}>{footer}</div>}
        </div>
      </main>
    </div>
  );
}
