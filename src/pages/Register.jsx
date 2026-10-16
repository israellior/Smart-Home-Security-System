import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { AuthLayout } from '../components/AuthLayout';
import {
  Field,
  FormError,
  PasswordInput,
  Requirement,
  SubmitButton,
  TextInput,
  authErrorMessage
} from '../components/AuthForm';

// The server's rule (authController.register), shown before it is broken
// rather than after.
const MIN_PASSWORD = 8;

export function Register() {
  const { register } = useAuth();
  const location = useLocation();
  const [name, setName] = useState('');
  const [email, setEmail] = useState(location.state?.email || '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await register(name.trim(), email.trim(), password);
    } catch (err) {
      setError(authErrorMessage(err));
      setSubmitting(false);
    }
  };

  const carry = { ...location.state, email: email.trim() || undefined };

  return (
    <AuthLayout
      title="Create your account"
      subtitle="Then add your doorbell, or join one someone has shared with you."
      footer={
        <>
          Already have an account?{' '}
          <Link to="/login" state={carry}>
            Log in
          </Link>
        </>
      }
    >
      <FormError>{error}</FormError>

      <form onSubmit={handleSubmit}>
        <Field id="name" label="Name">
          <TextInput
            id="name"
            type="text"
            autoComplete="name"
            autoFocus
            required
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>

        <Field id="email" label="Email">
          <TextInput
            id="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>

        <Field
          id="password"
          label="Password"
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
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>

        <SubmitButton busy={submitting} busyLabel="Creating account…">
          Create account
        </SubmitButton>
      </form>
    </AuthLayout>
  );
}
