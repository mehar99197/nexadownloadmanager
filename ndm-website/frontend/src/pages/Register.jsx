import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/Toast';
import Section from '../components/Section';
import Card from '../components/Card';
import Button from '../components/Button';
import Input from '../components/Input';
import Spinner from '../components/Spinner';

export default function Register() {
  const { register, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  if (isAuthenticated) {
    navigate('/dashboard', { replace: true });
    return <Spinner center />;
  }

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    setSubmitting(true);
    try {
      await register({ name, email, password });
      toast.success('Account created! Please check your email to verify.');
      navigate('/login', { replace: true });
    } catch (err) {
      const msg =
        err?.response?.data?.error?.message ||
        err?.message ||
        'Registration failed. Please try again.';
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Section className="auth-section flex min-h-[70vh] items-center">
      <div className="mx-auto w-full max-w-md">
        <div className="mb-5 text-center">
          <span className="eyebrow"><span className="eyebrow-dot" />Start moving faster</span>
        </div>
        <Card className="auth-card !p-8 sm:!p-9">
          <h1 className="text-3xl font-extrabold tracking-tight text-white">Create your <span className="text-gradient">flow.</span></h1>
          <p className="mt-2 text-sm leading-6 text-slate-400">
            Start downloading faster — it&apos;s free.
          </p>

          <form onSubmit={handleSubmit} className="mt-7 space-y-4" noValidate>
            <Input
              label="Name"
              name="name"
              type="text"
              autoComplete="name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Input
              label="Email"
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Input
              label="Password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              hint="At least 8 characters"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />

            {error && (
                <div className="rounded-xl border border-red-400/25 bg-red-400/10 px-4 py-3 text-sm text-red-200">
                {error}
              </div>
            )}

            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? 'Creating account…' : 'Create account'}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-slate-500">
            Already have an account?{' '}
            <Link
              to="/login"
              className="font-medium text-brand-300 hover:text-brand-200 hover:underline"
            >
              Sign in
            </Link>
          </p>
        </Card>
      </div>
    </Section>
  );
}
