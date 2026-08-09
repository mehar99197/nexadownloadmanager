import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/Toast';
import Section from '../components/Section';
import Card from '../components/Card';
import Button from '../components/Button';
import Input from '../components/Input';
import Spinner from '../components/Spinner';

export default function Login() {
  const { login, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [searchParams] = useSearchParams();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  if (isAuthenticated) {
    navigate('/dashboard', { replace: true });
    return <Spinner center />;
  }

  const next = searchParams.get('next') || '/dashboard';

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await login(email, password);
      toast.success('Logged in successfully.');
      navigate(next, { replace: true });
    } catch (err) {
      const msg =
        err?.response?.data?.error?.message ||
        err?.message ||
        'Login failed. Please try again.';
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Section className="auth-section flex min-h-[70vh] items-center">
      <div className="mx-auto w-full max-w-md">
        <div className="mb-5 text-center">
          <span className="eyebrow"><span className="eyebrow-dot" />Account access</span>
        </div>
        <Card className="auth-card !p-8 sm:!p-9">
          <h1 className="text-3xl font-extrabold tracking-tight text-white">Welcome <span className="text-gradient">back.</span></h1>
          <p className="mt-2 text-sm leading-6 text-slate-400">
            Welcome back. Enter your credentials to continue.
          </p>

          <form onSubmit={handleSubmit} className="mt-7 space-y-4" noValidate>
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
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />

            {error && (
                <div className="rounded-xl border border-red-400/25 bg-red-400/10 px-4 py-3 text-sm text-red-200">
                {error}
              </div>
            )}

            <div className="flex items-center justify-between">
              <Link
                to="/forgot-password"
                className="text-sm font-medium text-brand-300 hover:text-brand-200 hover:underline"
              >
                Forgot password?
              </Link>
            </div>

            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-slate-500">
            Don&apos;t have an account?{' '}
            <Link
              to="/register"
              className="font-medium text-brand-300 hover:text-brand-200 hover:underline"
            >
              Create one
            </Link>
          </p>
        </Card>
      </div>
    </Section>
  );
}
