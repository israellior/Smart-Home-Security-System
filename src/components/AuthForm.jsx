import { useState } from 'react';
import { EyeIcon, EyeOffIcon, AlertIcon, CheckIcon } from './Icons';
import styles from './AuthForm.module.css';

/**
 * The parts the logged-out forms are built from, so the four of them
 * cannot drift apart: a field, a password field, the submit button, and
 * the error above them.
 */

/**
 * What a failed auth request should say. The server's own message when
 * there is one - it is written for people already ("Incorrect email or
 * password") - and something human when there is none: a fetch that
 * never reached the server throws "Failed to fetch", which is the
 * browser talking, not us.
 */
export function authErrorMessage(err) {
  if (!err?.status) return "Can't reach Porchlight right now. Check your connection and try again.";
  if (err.status >= 500) return 'Something went wrong on our side. Please try again in a moment.';
  return err.message;
}

export function FormError({ children }) {
  if (!children) return null;
  return (
    <div className={styles.error} role="alert">
      <AlertIcon size={17} />
      <span>{children}</span>
    </div>
  );
}

export function Field({ id, label, aside, hint, children }) {
  return (
    <div className={styles.field}>
      <div className={styles.labelRow}>
        <label className={styles.label} htmlFor={id}>
          {label}
        </label>
        {aside}
      </div>
      {children}
      {hint}
    </div>
  );
}

export function TextInput(props) {
  return <input className={styles.input} {...props} />;
}

/**
 * A password input with a show/hide button and a Caps Lock warning -
 * the two things that account for most "my password doesn't work".
 *
 * Caps Lock is read off the key events rather than polled: browsers only
 * expose it through getModifierState on an event, and only while the
 * field has focus, which is exactly when the warning matters.
 */
export function PasswordInput({ id, describedBy, ...props }) {
  const [visible, setVisible] = useState(false);
  const [capsLock, setCapsLock] = useState(false);

  const readCapsLock = (e) => {
    if (typeof e.getModifierState === 'function') setCapsLock(e.getModifierState('CapsLock'));
  };

  const capsId = `${id}-caps`;
  const describedByIds = [describedBy, capsLock ? capsId : null].filter(Boolean).join(' ') || undefined;

  return (
    <>
      <div className={styles.passwordWrap}>
        <input
          id={id}
          className={`${styles.input} ${styles.passwordInput}`}
          type={visible ? 'text' : 'password'}
          aria-describedby={describedByIds}
          onKeyDown={readCapsLock}
          onKeyUp={readCapsLock}
          onBlur={() => setCapsLock(false)}
          // Show/hide turns autocorrect into a risk: a visible password
          // is a text field, and phones would happily "fix" it.
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          {...props}
        />
        <button
          type="button"
          className={styles.reveal}
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
          aria-controls={id}
          title={visible ? 'Hide password' : 'Show password'}
        >
          {visible ? <EyeOffIcon size={18} /> : <EyeIcon size={18} />}
        </button>
      </div>
      {capsLock && (
        <p id={capsId} className={styles.capsLock}>
          Caps Lock is on
        </p>
      )}
    </>
  );
}

/** A requirement under a field that ticks itself off as it's met. */
export function Requirement({ id, met, children }) {
  return (
    <p id={id} className={`${styles.requirement} ${met ? styles.met : ''}`}>
      <CheckIcon size={14} />
      {children}
    </p>
  );
}

export function SubmitButton({ busy, busyLabel, children }) {
  return (
    <button className={styles.submit} type="submit" disabled={busy} aria-busy={busy}>
      {busy && <span className={styles.spinner} aria-hidden="true" />}
      {busy ? busyLabel : children}
    </button>
  );
}
