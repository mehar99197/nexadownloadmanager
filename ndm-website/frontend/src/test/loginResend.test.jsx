/**
 * Login — "Send me a new verification link" must work when Turnstile is on.
 *
 * POST /auth/resend-verification sits behind the same Turnstile gate as
 * register and forgot-password (backend routes/auth.js). The login page sent
 * only the address and had no widget, so with a site key configured the
 * button always failed and an unverified account had no way to get a new
 * link. That is the dead end the button exists to prevent. The page now shows the
 * challenge next to the button and sends its token. Each token is single-use,
 * so a failed send asks for a fresh one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../api/client', () => {
  const api = { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() };
  return {
    default: api,
    unwrap: (res) => res?.data?.data,
    SESSION_ENDED_EVENT: 'ndm:session-ended',
    setAccessToken: vi.fn(),
    clearAccessToken: vi.fn(),
    restoreSession: vi.fn(async () => false),
  };
});
import api from '../api/client';

const authState = vi.hoisted(() => ({
  login: null,
  completeTwoFactor: () => Promise.resolve(),
  loginWithGoogle: () => Promise.resolve({}),
  isAuthenticated: false,
}));
vi.mock('../context/AuthContext', () => ({
  useAuth: () => authState,
  AuthProvider: ({ children }) => children,
}));

// The real widget needs Cloudflare's script. This stand-in hands over a token
// when "solved" and shows which reset it is on, the two things the page drives.
const turnstile = vi.hoisted(() => ({ enabled: true }));
vi.mock('../components/Turnstile', () => ({
  turnstileEnabled: () => turnstile.enabled,
  default: ({ onToken, resetKey = 0 }) => (turnstile.enabled ? (
    <button type="button" data-reset={resetKey} onClick={() => onToken(`token-${resetKey}`)}>
      Solve the challenge
    </button>
  ) : null),
}));

import { ToastProvider } from '../components/Toast';
import Login from '../pages/Login';

const unverified = () => Object.assign(new Error('Please verify your email address first.'), {
  response: { data: { ok: false, error: { code: 'EMAIL_NOT_VERIFIED', message: 'Please verify your email address first.' } } },
});

async function signInUnverified() {
  render(
    <MemoryRouter initialEntries={['/login']}>
      <ToastProvider><Login /></ToastProvider>
    </MemoryRouter>,
  );
  await userEvent.type(screen.getByLabelText('Email'), 'new@example.test');
  await userEvent.type(screen.getByLabelText('Password'), 'correct horse');
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  return screen.findByRole('button', { name: 'Send me a new verification link' });
}

beforeEach(() => {
  api.post.mockReset();
  authState.login = vi.fn(() => Promise.reject(unverified()));
  turnstile.enabled = true;
});

describe('Login — resending the verification link', () => {
  it('with Turnstile on, waits for the challenge and sends its token', async () => {
    api.post.mockResolvedValue({ data: { ok: true, data: {} } });
    const resend = await signInUnverified();

    expect(resend).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Solve the challenge' }));
    expect(resend).toBeEnabled();

    await userEvent.click(resend);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/auth/resend-verification', { email: 'new@example.test', turnstileToken: 'token-0' },
    ));
  });

  it('after a failed send, asks for a fresh challenge instead of reusing the spent token', async () => {
    api.post.mockRejectedValue(Object.assign(new Error('refused'), { response: { status: 403 } }));
    const resend = await signInUnverified();

    await userEvent.click(screen.getByRole('button', { name: 'Solve the challenge' }));
    await userEvent.click(resend);
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));

    const widget = screen.getByRole('button', { name: 'Solve the challenge' });
    await waitFor(() => expect(widget).toHaveAttribute('data-reset', '1'));
    expect(screen.getByRole('button', { name: 'Send me a new verification link' })).toBeDisabled();
  });

  it('with Turnstile off, sends the address alone, as before', async () => {
    turnstile.enabled = false;
    api.post.mockResolvedValue({ data: { ok: true, data: {} } });
    const resend = await signInUnverified();

    expect(resend).toBeEnabled();
    await userEvent.click(resend);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/auth/resend-verification', { email: 'new@example.test' },
    ));
  });
});
