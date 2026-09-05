import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useDevices } from '../context/DevicesContext';
import { api } from '../api/client';
import styles from './DeviceSharing.module.css';

/**
 * Who can see this doorbell, and how to change that.
 *
 * The share code is only rendered for owners - the API doesn't send it
 * to members at all, so this isn't merely hiding it in the UI. Same for
 * the remove buttons: the server enforces owner-only, and this just
 * avoids offering an action that would 403.
 */
export function DeviceSharing({ device }) {
  const { token } = useAuth();
  const { deleteDevice, leaveDevice } = useDevices();
  const navigate = useNavigate();

  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirmingDanger, setConfirmingDanger] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef(null);

  const deviceId = device._id;
  const isOwner = device.role === 'owner';

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    async function load() {
      try {
        const { members } = await api.listMembers(token, deviceId);
        if (!cancelled) setMembers(members);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [token, deviceId]);

  // The "Copied" flash clears itself on the next copy, but nothing
  // cancels it if you navigate away first.
  useEffect(() => () => clearTimeout(copyTimer.current), []);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(device.shareCode);
      setCopied(true);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1600);
    } catch (err) {
      // Clipboard needs a secure context and permission; if it's denied
      // the code is still on screen to read.
      setError('Couldn’t copy — you can select the code instead.');
    }
  };

  const handleRemoveMember = async (userId) => {
    setBusy(true);
    setError(null);
    try {
      await api.removeMember(token, deviceId, userId);
      setMembers((prev) => prev.filter((m) => m.userId !== userId));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

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
      {isOwner && (
        <>
          <p className={styles.sectionLabel}>Share this doorbell</p>
          <div className={styles.fieldGroup}>
            <p className={styles.help}>
              Anyone who enters this code can see this doorbell and its activity. Only share it
              with people you live with.
            </p>
            <div className={styles.codeRow}>
              <code className={styles.code}>{device.shareCode}</code>
              <button className={styles.copyBtn} type="button" onClick={handleCopy}>
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
        </>
      )}

      <p className={styles.sectionLabel}>Who has access</p>
      <div className={styles.fieldGroup}>
        {loading && <p className={styles.help}>Loading…</p>}
        {error && <p className={styles.error}>{error}</p>}

        {!loading &&
          members.map((member) => (
            <div className={styles.memberRow} key={member.userId}>
              <span className={styles.memberText}>
                <span className={styles.memberName}>
                  {member.name}
                  {member.isYou && <span className={styles.youTag}>You</span>}
                </span>
                <span className={styles.memberMeta}>
                  {member.email} · {member.role === 'owner' ? 'Owner' : 'Member'}
                </span>
              </span>
              {isOwner && !member.isYou && member.role !== 'owner' && (
                <button
                  className={styles.removeBtn}
                  type="button"
                  disabled={busy}
                  onClick={() => handleRemoveMember(member.userId)}
                >
                  Remove
                </button>
              )}
            </div>
          ))}
      </div>

      <p className={styles.sectionLabel}>{isOwner ? 'Delete' : 'Leave'}</p>
      <div className={styles.fieldGroup}>
        <p className={styles.help}>
          {isOwner
            ? 'Deletes this doorbell for everyone, along with all of its activity. This cannot be undone.'
            : 'Removes this doorbell from your list. The owner can share the code again if you need it back.'}
        </p>
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
