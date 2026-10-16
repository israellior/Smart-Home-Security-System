import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api } from '../api/client';
import { AuthLayout } from '../components/AuthLayout';
import { Field, FormError, SubmitButton, TextInput, authErrorMessage } from '../components/AuthForm';
import styles from './Auth.module.css';

/**
 * Asks for a reset link. What comes back is the same whether or not the
 * address has an account - that's the server's doing, and the wording
 * here keeps to it: "if an account exists", never "we've emailed you".
 */
export function ForgotPassword() {
  const location = useLocation();
  const [email, setEmail] = useState(location.state?.email || '');
  const [sentTo, setSentTo] = useState(null);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const send = async () => {
    setError(null);
    setSubmitting(true);
    try {
      await api.forgotPassword(email.trim());
      setSentTo(email.trim());
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    send();
  };

  const backToLogin = (
    <Link to="/login" state={{ ...location.state, email: email.trim() || undefined }}>
      Back to log in
    </Link>
  );

  if (sentTo) {
    return (
      <AuthLayout title="Check your email" footer={backToLogin}>
        <p className={styles.body}>
          If there's a Porchlight account for <strong>{sentTo}</strong>, a link to choose a new
          password is on its way. It works once, for the next hour.
        </p>
        <p className={styles.body}>Nothing after a few minutes? Check your spam folder.</p>

        <FormError>{error}</FormError>

        <button type="button" className={styles.secondary} onClick={send} disabled={submitting}>
          {submitting ? 'Sending…' : 'Send it again'}
        </button>
        <button
          type="button"
          className={styles.textButton}
          onClick={() => {
            setSentTo(null);
            setError(null);
          }}
        >
          Use a different email
        </button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Forgot your password?"
      subtitle="Enter the email you signed up with and we'll send you a link to choose a new one."
      footer={backToLogin}
    >
      <FormError>{error}</FormError>

      <form onSubmit={handleSubmit}>
        <Field id="email" label="Email">
          <TextInput
            id="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            autoFocus
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>

        <SubmitButton busy={submitting} busyLabel="Sending…">
          Send reset link
        </SubmitButton>
      </form>
    </AuthLayout>
  );
}
