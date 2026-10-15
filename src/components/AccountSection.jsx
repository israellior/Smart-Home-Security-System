import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import styles from './AccountSection.module.css';

/**
 * Account-level actions, at the foot of Home - the one page that is about
 * the account rather than a doorbell.
 *
 * "Sign out everywhere" is the answer to "someone else has my login":
 * every session this account has, on every phone and laptop, this one
 * included, stops working at once. Two steps, like deleting a doorbell,
 * because it signs out devices the person is not holding.
 */
export function AccountSection() {
  const { user, signOutEverywhere } = useAuth();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const handleConfirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await signOutEverywhere();
      // Success signs this tab out too, which unmounts this component.
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <>
      <p className={styles.sectionLabel}>Account</p>
      <div className={styles.group}>
        <p className={styles.email}>{user?.email}</p>
        <p className={styles.help}>
          Lost a phone, or think someone else has your password? This signs out every device
          logged into your account, including this one.
        </p>
        {error && <p className={styles.error}>{error}</p>}
        {confirming ? (
          <div className={styles.confirmRow}>
            <button className={styles.dangerBtn} type="button" disabled={busy} onClick={handleConfirm}>
              {busy ? 'Working…' : 'Yes, sign out everywhere'}
            </button>
            <button
              className={styles.cancelBtn}
              type="button"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button className={styles.dangerBtn} type="button" onClick={() => setConfirming(true)}>
            Sign out everywhere
          </button>
        )}
      </div>
    </>
  );
}
