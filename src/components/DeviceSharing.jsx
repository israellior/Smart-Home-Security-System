import { useEffect, useRef, useState } from 'react';
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
 *
 * A doorbell now starts with no share code at all, and that is the point
 * rather than an omission. Share codes used to be minted with the hardware
 * and printed beside its credential, which meant the code granting
 * permanent access to a camera was readable off the back of a case by
 * anyone who handled the box. Ownership comes from the one-time claim code
 * instead; this screen is where an owner deliberately creates a sharing
 * code, rotates it, or takes it away.
 */
export function DeviceSharing({ device }) {
  const { token } = useAuth();
  const { createShareCode, revokeShareCode } = useDevices();

  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
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

  const handleShareCode = async (action) => {
    setBusy(true);
    setError(null);
    try {
      await action(deviceId);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

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

  return (
    <>
      {isOwner && (
        <>
          <p className={styles.sectionLabel}>Share this doorbell</p>
          <div className={styles.fieldGroup}>
            {device.shareCode ? (
              <>
                <p className={styles.help}>
                  Anyone who enters this code can see this doorbell and its activity. Only share
                  it with people you live with, and turn it off when you are done — it keeps
                  working until you do.
                </p>
                <div className={styles.codeRow}>
                  <code className={styles.code}>{device.shareCode}</code>
                  <button className={styles.copyBtn} type="button" onClick={handleCopy}>
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <div className={styles.confirmRow}>
                  {/* Rotating is the answer to "somebody has this code and
                      shouldn't". Removing their membership stops them
                      watching; replacing the code stops them re-joining
                      with it, and those are two different things. */}
                  <button
                    className={styles.copyBtn}
                    type="button"
                    disabled={busy}
                    onClick={() => handleShareCode(createShareCode)}
                  >
                    {busy ? 'Working…' : 'Replace code'}
                  </button>
                  <button
                    className={styles.copyBtn}
                    type="button"
                    disabled={busy}
                    onClick={() => handleShareCode(revokeShareCode)}
                  >
                    Turn off sharing
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className={styles.help}>
                  There is no sharing code for this doorbell. Make one when you want to let
                  somebody else see it — you can replace or remove it at any time, and nobody
                  can join without one.
                </p>
                <button
                  className={styles.copyBtn}
                  type="button"
                  disabled={busy}
                  onClick={() => handleShareCode(createShareCode)}
                >
                  {busy ? 'Working…' : 'Create a sharing code'}
                </button>
              </>
            )}
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

    </>
  );
}
