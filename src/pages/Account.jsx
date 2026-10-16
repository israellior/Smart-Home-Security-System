import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useDevices } from '../context/DevicesContext';
import { useTheme } from '../context/ThemeContext';
import { PushSection } from '../components/PushSection';
import { SegmentedControl } from '../components/SegmentedControl';
import { Field, PasswordInput, Requirement } from '../components/AuthForm';
import settings from './Settings.module.css';
import styles from './Account.module.css';

const MIN_PASSWORD = 8;

const THEME_OPTIONS = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' }
];

/**
 * Everything about you rather than about one doorbell: your name, which
 * of your devices get alerts, how the app looks, your password, your
 * sessions - and deleting the account.
 *
 * Laid out in the same rhythm as a doorbell's Settings (Settings.module
 * .css), so the two read as one place with two pages.
 */
export function Account() {
  const { hash, key } = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'start' });
  }, [hash]);

  // Installed on an iPhone's Home Screen, the app has no browser back
  // button, so every page needs its own way out. Back to wherever you came
  // from - often a doorbell's Settings - and home when there is nowhere
  // in the app to go back to (React Router's first entry has key
  // 'default'). A real href underneath, so it still works as a link.
  const goBack = (e) => {
    if (key !== 'default') {
      e.preventDefault();
      navigate(-1);
    }
  };

  return (
    <section>
      <Link to="/" className={styles.back} onClick={goBack}>
        ‹ Back
      </Link>
      <h1 className={styles.title}>Account</h1>
      <Profile />

      <p className={settings.sectionLabel} id="notifications">
        Notifications
      </p>
      <PushSection />

      <Appearance />
      <Password />
      <Sessions />
      <DeleteAccount />
    </section>
  );
}

function Profile() {
  const { user, updateProfile } = useAuth();
  const [name, setName] = useState(user?.name || '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  const changed = name.trim() !== (user?.name || '') && name.trim().length > 0;

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await updateProfile({ name: name.trim() });
      setMessage({ tone: 'ok', text: 'Saved.' });
    } catch (err) {
      setMessage({ tone: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className={settings.sectionLabel}>Profile</p>
      <form className={settings.fieldGroup} onSubmit={save}>
        <label className={settings.fieldLabel} htmlFor="account-name">
          Name
        </label>
        <p className={settings.fieldHelp}>How the app greets you, and what people you share with see</p>
        <div className={styles.inline}>
          <input
            id="account-name"
            className={settings.textInput}
            type="text"
            autoComplete="name"
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit" className={styles.button} disabled={!changed || busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
        <Message message={message} />

        <div className={`${settings.aboutRow} ${styles.emailRow}`}>
          <span>Email</span>
          <span>{user?.email}</span>
        </div>
      </form>
    </>
  );
}

function Appearance() {
  const { theme, setTheme } = useTheme();
  return (
    <>
      <p className={settings.sectionLabel}>Appearance</p>
      <div className={settings.fieldGroup}>
        <p className={settings.fieldHelp}>
          System follows your phone or computer's own setting.
        </p>
        <SegmentedControl
          options={THEME_OPTIONS}
          value={theme || 'system'}
          onChange={(value) => setTheme(value === 'system' ? null : value)}
        />
      </div>
    </>
  );
}

function Password() {
  const { changePassword } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  const ready = current.length > 0 && next.length >= MIN_PASSWORD;

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await changePassword(current, next);
      setCurrent('');
      setNext('');
      setMessage({ tone: 'ok', text: 'Password changed. Your other devices have been signed out.' });
    } catch (err) {
      setMessage({ tone: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className={settings.sectionLabel}>Password</p>
      <form className={`${settings.fieldGroup} ${styles.passwordForm}`} onSubmit={save}>
        {/* Lets a password manager tie the new password to this account. */}
        <input type="text" name="username" autoComplete="username" hidden readOnly />
        <Field id="current-password" label="Current password">
          <PasswordInput
            id="current-password"
            autoComplete="current-password"
            required
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </Field>
        <Field
          id="new-password"
          label="New password"
          hint={
            <Requirement id="new-password-rule" met={next.length >= MIN_PASSWORD}>
              At least {MIN_PASSWORD} characters
            </Requirement>
          }
        >
          <PasswordInput
            id="new-password"
            describedBy="new-password-rule"
            autoComplete="new-password"
            minLength={MIN_PASSWORD}
            required
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        </Field>
        <p className={settings.fieldHelp}>
          Changing it signs out your other phones and computers. This one stays signed in.
        </p>
        <button type="submit" className={styles.button} disabled={!ready || busy}>
          {busy ? 'Changing…' : 'Change password'}
        </button>
        <Message message={message} />
      </form>
    </>
  );
}

/**
 * Leaving: this device, or every device. "Sign out everywhere" is the
 * answer to "someone else has my login" - every session, this one
 * included, stops at once. Two steps, because it signs out devices the
 * person isn't holding.
 */
function Sessions() {
  const { logout, signOutEverywhere } = useAuth();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const everywhere = async () => {
    setBusy(true);
    setError(null);
    try {
      await signOutEverywhere();
      // Success signs this tab out too, which unmounts this page.
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <>
      <p className={settings.sectionLabel}>Signing out</p>
      <div className={settings.fieldGroup}>
        <div className={styles.actionRow}>
          <div>
            <p className={settings.fieldLabel}>Log out of this device</p>
            <p className={styles.small}>Notifications stop here too.</p>
          </div>
          <button type="button" className={styles.quietBtn} onClick={logout}>
            Log out
          </button>
        </div>

        <div className={`${styles.actionRow} ${styles.divided}`}>
          <div>
            <p className={settings.fieldLabel}>Sign out everywhere</p>
            <p className={styles.small}>
              Lost a phone, or think someone else has your password? Every device logged into your
              account is signed out, including this one.
            </p>
          </div>
        </div>
        {error && <p className={styles.error}>{error}</p>}
        {confirming ? (
          <div className={styles.confirmRow}>
            <button className={styles.dangerBtn} type="button" disabled={busy} onClick={everywhere}>
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

/**
 * Says exactly what goes, by name: the doorbells you own are deleted for
 * everyone they're shared with, clips included. Asks for the password
 * rather than a second click - this one cannot be undone at all.
 */
function DeleteAccount() {
  const { deleteAccount } = useAuth();
  const { devices } = useDevices();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const owned = devices.filter((d) => d.role === 'owner');
  const joined = devices.length - owned.length;

  const confirm = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await deleteAccount(password);
      // Signed out on success; this page unmounts.
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <>
      <p className={settings.sectionLabel}>Delete account</p>
      <div className={settings.fieldGroup}>
        <p className={styles.small}>
          Deletes your account and everything in it. This cannot be undone.
        </p>
        {owned.length > 0 && (
          <p className={styles.small}>
            {owned.length === 1 ? 'The doorbell you own, ' : 'The doorbells you own, '}
            <strong>{owned.map((d) => d.name).join(', ')}</strong>,{' '}
            {owned.length === 1 ? 'is' : 'are'} deleted too — for everyone {owned.length === 1 ? 'it is' : 'they are'}{' '}
            shared with, with all {owned.length === 1 ? 'its' : 'their'} clips, and the hardware
            stops working until it is set up again.
          </p>
        )}
        {joined > 0 && (
          <p className={styles.small}>
            You'll also leave {joined === 1 ? 'the doorbell' : `the ${joined} doorbells`} shared with
            you.
          </p>
        )}

        {open ? (
          <form onSubmit={confirm} className={styles.passwordForm}>
            <input type="text" name="username" autoComplete="username" hidden readOnly />
            <Field id="delete-password" label="Enter your password to confirm">
              <PasswordInput
                id="delete-password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            {error && <p className={styles.error}>{error}</p>}
            <div className={styles.confirmRow}>
              <button className={styles.dangerBtn} type="submit" disabled={busy || !password}>
                {busy ? 'Deleting…' : 'Delete my account'}
              </button>
              <button
                className={styles.cancelBtn}
                type="button"
                disabled={busy}
                onClick={() => {
                  setOpen(false);
                  setPassword('');
                  setError(null);
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <button className={styles.dangerBtn} type="button" onClick={() => setOpen(true)}>
            Delete account…
          </button>
        )}
      </div>
    </>
  );
}

function Message({ message }) {
  if (!message) return null;
  return (
    <p className={message.tone === 'error' ? styles.error : styles.ok} role="status">
      {message.text}
    </p>
  );
}
