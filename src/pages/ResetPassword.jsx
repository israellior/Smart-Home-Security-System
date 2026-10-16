import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { AuthLayout } from '../components/AuthLayout';
import {
  Field,
  FormError,
  PasswordInput,
  Requirement,
  SubmitButton,
  authErrorMessage
} from '../components/AuthForm';
import styles from './Auth.module.css';

const MIN_PASSWORD = 8;

/**
 * The page a reset email links to: /reset-password#<token>.
 *
 * The token is in the fragment so it never reaches a server log (see
 * accountEmails.js on the backend). It is read once into state and then
 * taken out of the address bar, so it isn't left in history or on screen
 * for anyone looking over a shoulder.
 */
export function ResetPassword() {
  const { resetPassword } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [token] = useState(() => location.hash.slice(1));
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [expired, setExpired] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (location.hash) navigate(location.pathname, { replace: true });
  }, [location.hash, location.pathname, navigate]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await resetPassword(token, password);
      navigate('/', { replace: true });
    } catch (err) {
      // A 400 that isn't about the password is the link itself: used,
      // replaced by a newer one, or past its hour.
      if (err.status === 400 && password.length >= MIN_PASSWORD) setExpired(true);
      else setError(authErrorMessage(err));
      setSubmitting(false);
    }
  };

  const footer = <Link to="/login">Back to log in</Link>;

  if (!token || expired) {
    return (
      <AuthLayout
        title={expired ? 'This link has expired' : 'This link is incomplete'}
        footer={footer}
      >
        <p className={styles.body}>
          {expired
            ? 'Reset links work once, for an hour, and only the newest one you asked for. Ask for another and use the link in that email.'
            : "The link didn't come through whole. Try opening it from the email again, or ask for a new one."}
        </p>
        <Link to="/forgot-password" className={styles.secondary}>
          Send me a new link
        </Link>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Choose a new password"
      subtitle="You'll be logged in with it straight away, and logged out everywhere else."
      footer={footer}
    >
      <FormError>{error}</FormError>

      <form onSubmit={handleSubmit}>
        <Field
          id="password"
          label="New password"
          hint={
            <Requirement id="password-rule" met={password.length >= MIN_PASSWORD}>
              At least {MIN_PASSWORD} characters
            </Requirement>
          }
        >
          <PasswordInput
            id="password"
            describedBy="password-rule"
            autoComplete="new-password"
            minLength={MIN_PASSWORD}
            autoFocus
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>

        <SubmitButton busy={submitting} busyLabel="Saving…">
          Save and log in
        </SubmitButton>
      </form>
    </AuthLayout>
  );
}
