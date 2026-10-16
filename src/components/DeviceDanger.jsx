import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDevices } from '../context/DevicesContext';
import styles from './DeviceSharing.module.css';

/**
 * Delete (owner) or leave (member) - always the last thing on a doorbell's
 * Settings, under everything that can be undone. Two steps, because the
 * owner's version deletes the doorbell for everyone and stops the unit on
 * the wall.
 */
export function DeviceDanger({ device }) {
  const { deleteDevice, leaveDevice } = useDevices();
  const navigate = useNavigate();
  const [confirmingDanger, setConfirmingDanger] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const deviceId = device._id;
  const isOwner = device.role === 'owner';

  // Owners delete, members leave. Different endpoints, same outcome from
  // here: this doorbell is no longer on your list, so go back to it.
  const handleDanger = async () => {
    setBusy(true);
    setError(null);
    try {
      if (isOwner) await deleteDevice(deviceId);
      else await leaveDevice(deviceId);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err.message);
      setBusy(false);
      setConfirmingDanger(false);
    }
  };

  return (
    <>
      <p className={styles.sectionLabel}>{isOwner ? 'Delete' : 'Leave'}</p>
      <div className={styles.fieldGroup}>
        <p className={styles.help}>
          {isOwner
            ? 'Deletes this doorbell for everyone, along with all of its activity. This cannot be undone.'
            : 'Removes this doorbell from your list. The owner can share the code again if you need it back.'}
        </p>
        {/*
          * Said plainly, because deleting is the one action here with a
          * consequence at the house rather than in the app. The server
          * closes the doorbell's socket with the code that means
          * "permanently refused", so the unit lights its fault pattern and
          * stops trying - by design, since its credential will never
          * authenticate again. Getting it back is a new credential and a
          * re-flash, which needs somebody at the door with the card.
          */}
        {isOwner && device.provisioned && (
          <p className={styles.help}>
            The doorbell itself will stop working and show a fault light. Bringing it back needs
            a new credential written onto its card — not something the app can do.
          </p>
        )}
        {error && <p className={styles.error}>{error}</p>}
        {confirmingDanger ? (
          <div className={styles.confirmRow}>
            <button
              className={styles.dangerBtn}
              type="button"
              disabled={busy}
              onClick={handleDanger}
            >
              {busy ? 'Working…' : isOwner ? 'Yes, delete it' : 'Yes, leave'}
            </button>
            <button
              className={styles.cancelBtn}
              type="button"
              disabled={busy}
              onClick={() => setConfirmingDanger(false)}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            className={styles.dangerBtn}
            type="button"
            onClick={() => setConfirmingDanger(true)}
          >
            {isOwner ? 'Delete this doorbell' : 'Leave this doorbell'}
          </button>
        )}
      </div>
    </>
  );
}
