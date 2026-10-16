import { usePushNotifications } from '../hooks/usePushNotifications';
import { isIos } from '../lib/push';
import styles from './PushSection.module.css';

/**
 * Whether this phone or computer gets alerts at all. Sits above the
 * per-doorbell toggles in Settings, and says so: it is one switch per
 * browser, for every doorbell on the account, where the toggles below it
 * choose what each doorbell sends.
 */
export function PushSection() {
  const { status, busy, message, enable, disable, sendTest } = usePushNotifications();
  const thing = isIos() || /Android/.test(navigator.userAgent) ? 'phone' : 'device';

  let tone = 'neutral';
  let text;
  let actions = null;

  switch (status) {
    case 'loading':
      text = 'Checking this device…';
      break;
    case 'on':
      tone = 'good';
      text = `On for this ${thing}. Alerts from all your doorbells come here.`;
      actions = (
        <>
          <button type="button" className={styles.button} onClick={sendTest} disabled={busy}>
            Send a test
          </button>
          <button type="button" className={styles.quiet} onClick={disable} disabled={busy}>
            Turn off
          </button>
        </>
      );
      break;
    case 'off':
      text = `Get an alert on this ${thing} when someone rings or there's movement at the door.`;
      actions = (
        <button type="button" className={styles.button} onClick={enable} disabled={busy}>
          {busy ? 'Turning on…' : 'Turn on notifications'}
        </button>
      );
      break;
    case 'blocked':
      tone = 'bad';
      text =
        'Notifications are blocked for Porchlight in this browser. Allow them in its site settings (the icon left of the address), then come back here.';
      break;
    case 'install-first':
      tone = 'news';
      text = (
        <>
          On iPhone and iPad, Porchlight has to be on your Home Screen to send notifications. In
          Safari, tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>, then open
          Porchlight from there and turn them on.
        </>
      );
      break;
    default:
      text = "This browser can't show notifications. Chrome, Edge, Firefox and Safari all can.";
  }

  return (
    <div className={styles.wrap}>
      <p className={styles.label}>On this {thing}</p>
      <div className={`${styles.status} ${styles[`tone_${tone}`]}`}>
        <p className={styles.text}>{text}</p>
      </div>
      {actions && <div className={styles.actions}>{actions}</div>}
      {message && (
        <p className={message.tone === 'error' ? styles.error : styles.ok} role="status">
          {message.text}
        </p>
      )}
    </div>
  );
}
