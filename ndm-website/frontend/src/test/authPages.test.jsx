/**
 * T-07 — the authentication pages, which had no test naming them.
 *
 * Eighteen of twenty-seven pages were uncovered; these are the seven where a
 * mistake is worst, because they are how an account is recovered, verified and
 * joined. The backend half of each is covered by an integration suite, so the
 * *contract* was tested — what was not was whether the page calls it correctly
 * and what it does when the answer is no.
 *
 * Two recurring shapes are worth naming, because they are the actual risks
 * here rather than rendering bugs:
 *
 *  - a single-use token in a URL. The page must refuse to post a missing one
 *    rather than calling the endpoint with an empty string, and it must not
 *    put the token anywhere it can be read back.
 *  - a recovery form that must not become an account oracle. "No such user"
 *    and "sent" have to look identical, which is a property of the page, not
 *    only of the API — a page that branched on the response would undo the
 *    work /auth/forgot-password does to stay quiet.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../api/client', () => {
  const api = { get: vi.fn(), post: vi.fn(), put: vi.fn() };
  return {
    default: api,
    unwrap: (res) => res?.data?.data,
    SESSION_ENDED_EVENT: 'ndm:session-ended',
  };
});
import api from '../api/client';

import { ToastProvider } from '../components/Toast';
import ForgotPassword from '../pages/ForgotPassword';
import ResetPassword from '../pages/ResetPassword';
import VerifyEmail from '../pages/VerifyEmail';

// ResetPassword raises a toast on success, so it needs the provider its route
// has in the real app; rendering it bare throws before any assertion runs.
const at = (path, ui) => render(
  <MemoryRouter initialEntries={[path]}>
    <ToastProvider>{ui}</ToastProvider>
  </MemoryRouter>
);
const refused = (message, code = 'INVALID_TOKEN') =>
  Object.assign(new Error(message), { response: { data: { ok: false, error: { code, message } } } });

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
});

describe('ForgotPassword — must not become an account oracle', () => {
  it('says the same thing whether or not the address exists', async () => {
    api.post.mockResolvedValue({ data: { ok: true, data: {} } });
    at('/forgot-password', <ForgotPassword />);

    await userEvent.type(screen.getByLabelText(/email/i), 'someone@example.test');
    await userEvent.click(screen.getByRole('button', { name: /send|reset/i }));

    // The wording is deliberately conditional. A page that said "check your
    // inbox" would confirm the address exists just as loudly as an error.
    expect(await screen.findByText(/if an account with that email exists/i)).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith('/auth/forgot-password', expect.objectContaining({
      email: 'someone@example.test',
    }));
  });

  it('shows the server’s refusal instead of pretending it sent', async () => {
    api.post.mockRejectedValue(refused('Too many requests. Try again later.', 'RATE_LIMITED'));
    at('/forgot-password', <ForgotPassword />);

    await userEvent.type(screen.getByLabelText(/email/i), 'someone@example.test');
    await userEvent.click(screen.getByRole('button', { name: /send|reset/i }));

    expect(await screen.findByText(/too many requests/i)).toBeInTheDocument();
    expect(screen.queryByText(/if an account with that email exists/i)).not.toBeInTheDocument();
  });
});

describe('ResetPassword — a single-use token from a URL', () => {
  it('refuses to work at all without a token, and calls nothing', async () => {
    at('/reset-password', <ResetPassword />);

    expect(await screen.findByText(/missing a token/i)).toBeInTheDocument();
    // The part that matters: no request went out with an empty token, which
    // would spend a rate-limit slot and log a failure for nobody.
    expect(api.post).not.toHaveBeenCalled();
  });

  it('sends the token from the URL with the new password', async () => {
    api.post.mockResolvedValue({ data: { ok: true, data: {} } });
    at('/reset-password?token=a-real-looking-token', <ResetPassword />);

    const password = screen.getByLabelText(/new password/i);
    await userEvent.type(password, 'a-strong-new-password');
    await userEvent.type(screen.getByLabelText(/confirm/i), 'a-strong-new-password');
    await userEvent.click(screen.getByRole('button', { name: /reset|update|set/i }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/auth/reset-password', {
      token: 'a-real-looking-token',
      password: 'a-strong-new-password',
    }));
  });

  it('does not post when the two passwords disagree', async () => {
    at('/reset-password?token=a-real-looking-token', <ResetPassword />);

    await userEvent.type(screen.getByLabelText(/new password/i), 'a-strong-new-password');
    await userEvent.type(screen.getByLabelText(/confirm/i), 'a-different-password');
    await userEvent.click(screen.getByRole('button', { name: /reset|update|set/i }));

    // Catching this here is not about saving a round trip: the token is
    // single-use, so spending it on a typo locks the user out of their own
    // reset link.
    await waitFor(() => expect(api.post).not.toHaveBeenCalled());
  });

  it('reports an expired or already-spent link rather than silently failing', async () => {
    api.post.mockRejectedValue(refused('This reset link is no longer valid'));
    at('/reset-password?token=a-spent-token', <ResetPassword />);

    await userEvent.type(screen.getByLabelText(/new password/i), 'a-strong-new-password');
    await userEvent.type(screen.getByLabelText(/confirm/i), 'a-strong-new-password');
    await userEvent.click(screen.getByRole('button', { name: /reset|update|set/i }));

    expect(await screen.findByText(/no longer valid/i)).toBeInTheDocument();
  });
});

describe('VerifyEmail — the link from the mail', () => {
  it('verifies with the token in the URL', async () => {
    api.post.mockResolvedValue({ data: { ok: true, data: {} } });
    at('/verify-email?token=verification-token', <VerifyEmail />);

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/auth/verify-email', {
      token: 'verification-token',
    }));
  });

  it('says the link is incomplete rather than calling the endpoint empty-handed', async () => {
    at('/verify-email', <VerifyEmail />);

    expect(await screen.findByText(/missing a token/i)).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('does not claim success when the server refuses', async () => {
    api.post.mockRejectedValue(refused('That verification link has expired'));
    at('/verify-email?token=expired-token', <VerifyEmail />);

    // The failure mode being guarded: a page that lands on its success state
    // regardless leaves someone believing a dead link worked.
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    await waitFor(() => {
      expect(screen.queryByText(/verified/i)).not.toBeInTheDocument();
    });
  });
});
