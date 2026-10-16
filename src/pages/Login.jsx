import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { AuthLayout } from '../components/AuthLayout';
import {
  Field,
  FormError,
  PasswordInput,
  SubmitButton,
  TextInput,
  authErrorMessage
} from '../components/AuthForm';

/**
 * Where a successful login goes is not decided here: GuestRoute sees the
 * session appear and sends you on, to the page you were turned away from
 * if there was one.
 */
export function Login() {
  const { login } = useAuth();
  const location = useLocation();
  // Carried back from "Forgot password?" so the address isn't typed twice.
  const [email, setEmail] = useState(location.state?.email || '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email.trim(), password);
    } catch (err) {
      setError(authErrorMessage(err));
      setSubmitting(false);
    }
  };

  // Router state rides along between the logged-out pages, so "where you
  // were going" survives a detour through Register or Forgot password.
  const carry = { ...location.state, email: email.trim() || undefined };

  return (
    <AuthLayout
      title="Welcome back"
      subtitle="Log in to see who's been at your door."
      footer={
        <>
          New to Porchlight?{' '}
          <Link to="/register" state={carry}>
            Create an account
          </Link>
        </>
      }
    >
      <FormError>{error}</FormError>

      <form onSubmit={handleSubmit}>
        <Field id="email" label="Email">
          <TextInput
            id="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            autoFocus={!email}
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>

        <Field
          id="password"
          label="Password"
          aside={
            <Link to="/forgot-password" state={carry}>
              Forgot password?
            </Link>
          }
        >
          <PasswordInput
            id="password"
            autoComplete="current-password"
            autoFocus={Boolean(email)}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>

        <SubmitButton busy={submitting} busyLabel="Logging in…">
          Log in
        </SubmitButton>
      </form>
    </AuthLayout>
  );
}
