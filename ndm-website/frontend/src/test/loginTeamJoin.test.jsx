/**
 * T-07, continued — the front door and the invitation landing page.
 *
 * Login is where a second factor is either asked for or quietly skipped, and
 * TeamJoin spends an invitation token from an email. Both were uncovered.
 *
 * `AuthContext` is mocked here rather than driven through the real provider:
 * these tests are about what the pages do with an answer — show the code box,
 * refuse to spend a missing token — not about how the session is established,
 * which `sessionEnded.test.jsx` and the backend suite already hold down.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

const login = vi.fn();
const completeTwoFactor = vi.fn();
const refreshMe = vi.fn();
const authState = { user: null, loading: false, isAuthenticated: false };

vi.mock('../api/client', () => {
  const api = { get: vi.fn(), post: vi.fn(), put: vi.fn() };
  return { default: api, unwrap: (res) => res?.data?.data, SESSION_ENDED_EVENT: 'ndm:session-ended' };
});
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    ...authState,
    login: (...a) => login(...a),
    completeTwoFactor: (...a) => completeTwoFactor(...a),
    loginWithGoogle: vi.fn(),
    refreshMe: (...a) => refreshMe(...a),
  }),
  AuthProvider: ({ children }) => children,
}));
import api from '../api/client';

import { ToastProvider } from '../components/Toast';
import Login from '../pages/Login';
import TeamJoin from '../pages/TeamJoin';

const at = (path, ui) => render(
  <MemoryRouter initialEntries={[path]}>
    <ToastProvider>{ui}</ToastProvider>
  </MemoryRouter>
);

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockReset();
  api.post.mockReset();
  authState.user = null;
  authState.loading = false;
  authState.isAuthenticated = false;
});

describe('Login — the second factor', () => {
  it('asks for the code when the server says the account has 2FA', async () => {
    // The password step deliberately establishes no session: it hands back a
    // short-lived challenge and nothing else.
    // AuthContext translates the API's { requiresTwoFactor } into its own
    // { twoFactor }, so a mock of the context has to speak the context's shape.
    // Getting that wrong is how this test first failed, and it is a real trap:
    // two names for one condition, three lines apart in the same flow.
    login.mockResolvedValue({ twoFactor: true, challenge: 'challenge-abc' });

    at('/login', <Login />);
    await userEvent.type(screen.getByLabelText(/email/i), 'someone@example.test');
    await userEvent.type(screen.getByLabelText(/^password/i), 'a-password');
    await userEvent.click(screen.getByRole('button', { name: /sign in|log in/i }));

    expect(await screen.findByLabelText('Verification code')).toBeInTheDocument();
    // And the password step is not treated as a completed sign-in.
    expect(completeTwoFactor).not.toHaveBeenCalled();
  });

  it('spends the challenge, not the password, on the second step', async () => {
    login.mockResolvedValue({ twoFactor: true, challenge: 'challenge-abc' });
    completeTwoFactor.mockResolvedValue({ token: 'session-token' });

    at('/login', <Login />);
    await userEvent.type(screen.getByLabelText(/email/i), 'someone@example.test');
    await userEvent.type(screen.getByLabelText(/^password/i), 'a-password');
    await userEvent.click(screen.getByRole('button', { name: /sign in|log in/i }));

    const code = await screen.findByLabelText('Verification code');
    await userEvent.type(code, '123456');
    // Named exactly: "Back to sign in" sits in the same form and matches any
    // looser pattern, and clicking that would abandon the challenge rather
    // than spend it. A test that passes by pressing the wrong button is
    // worse than no test.
    await userEvent.click(screen.getByRole('button', { name: 'Verify and sign in' }));

    await waitFor(() => expect(completeTwoFactor).toHaveBeenCalledWith('challenge-abc', '123456'));
  });

  it('shows a refusal rather than moving on', async () => {
    login.mockRejectedValue(Object.assign(new Error('Invalid email or password'), {
      response: { data: { ok: false, error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } } },
    }));

    at('/login', <Login />);
    await userEvent.type(screen.getByLabelText(/email/i), 'someone@example.test');
    await userEvent.type(screen.getByLabelText(/^password/i), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: /sign in|log in/i }));

    expect(await screen.findByText(/invalid email or password/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Verification code')).not.toBeInTheDocument();
  });
});

describe('TeamJoin — an invitation token from an email', () => {
  it('refuses a link with no token, and asks the server nothing', async () => {
    at('/team/join', <TeamJoin />);

    expect(await screen.findByText(/missing its invitation token/i)).toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalled();
  });

  it('looks the invitation up by the token in the URL', async () => {
    api.get.mockResolvedValue({
      data: { ok: true, data: { email: 'invitee@example.test', ownerName: 'Owner', status: 'invited' } },
    });

    at('/team/join?token=invite-token-123', <TeamJoin />);

    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/team/invites/invite-token-123'));
  });

  it('reports an expired invitation instead of offering to accept it', async () => {
    // M-12 gave invitations a TTL; 410 is what both readers answer once it has
    // passed. The page must not show an Accept button for a dead invite.
    api.get.mockRejectedValue(Object.assign(new Error('This invitation has expired'), {
      response: { status: 410, data: { ok: false, error: { code: 'INVITE_EXPIRED', message: 'This invitation has expired' } } },
    }));

    at('/team/join?token=stale-token', <TeamJoin />);

    expect(await screen.findByText(/expired/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^accept/i })).not.toBeInTheDocument();
  });
});
