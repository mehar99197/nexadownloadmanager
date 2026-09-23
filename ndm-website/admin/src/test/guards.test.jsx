/**
 * T-06 — the control panel's own logic, which had no tests at all.
 *
 * The backend suite covers the API these screens call, and that is the half
 * that matters for data exposure. What nothing covered was the panel's side of
 * the same contracts: that an unauthenticated visitor is sent to /login rather
 * than shown an empty dashboard, that an account which has not enrolled in 2FA
 * is parked on Security and released the moment it does enrol, and that a
 * session ending server-side actually ends it here.
 *
 * Each of those was verified by hand when it was built — which is exactly the
 * kind of verification that does not survive the next change.
 *
 * The API module is mocked rather than the network, because these tests are
 * about what the panel does with an answer, not about how it fetches one.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const refreshAdminToken = vi.fn();
const get = vi.fn();
const post = vi.fn();

vi.mock('../api/client.js', () => ({
  default: { get: (...a) => get(...a), post: (...a) => post(...a) },
  setAdminAccessToken: vi.fn(),
  clearAdminAccessToken: vi.fn(),
  refreshAdminToken: (...a) => refreshAdminToken(...a),
  unwrap: async (p) => {
    const res = await p;
    if (res?.data?.ok === false) throw new Error(res.data.error?.message || 'failed');
    return res?.data?.data;
  },
  TWO_FACTOR_REQUIRED_EVENT: 'ndm:two-factor-required',
  SESSION_ENDED_EVENT: 'ndm:session-ended',
}));

const { AdminAuthProvider, useAdminAuth } = await import('../context/AdminAuthContext.jsx');
const { default: ProtectedAdminRoute } = await import('../components/ProtectedAdminRoute.jsx');
const { default: AdminDashboard } = await import('../pages/AdminDashboard.jsx');

/**
 * Stands in for the Security page. Two things matter about it here: it calls
 * refreshAdmin() after a successful enable, and it is somewhere you can try to
 * leave from — because "the gate opened" means being able to go elsewhere, not
 * the URL changing by itself. A redirect leaves the router on /security, and
 * nothing navigates back for you.
 */
function EnrolStandIn() {
  const { refreshAdmin } = useAdminAuth();
  const navigate = useNavigate();
  return (
    <div>
      SECURITY SCREEN
      <button type="button" onClick={() => refreshAdmin()}>enrol</button>
      <button type="button" onClick={() => navigate('/users')}>go to users</button>
    </div>
  );
}

/** What GET /api/<realm>/me answers. */
const meAs = (overrides = {}) => ({
  data: {
    ok: true,
    data: {
      id: 1,
      name: 'Creator',
      email: 'creator@example.test',
      role: 'root',
      twoFactorRequired: false,
      twoFactorEnabled: true,
      ...overrides,
    },
  },
});

function renderPanel(initialPath = '/dashboard') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <AdminAuthProvider>
        <Routes>
          <Route path="/login" element={<div>SIGN IN SCREEN</div>} />
          <Route path="/security" element={<div>SECURITY SCREEN</div>} />
          <Route
            path="/dashboard"
            element={<ProtectedAdminRoute><div>DASHBOARD</div></ProtectedAdminRoute>}
          />
          <Route
            path="/users"
            element={<ProtectedAdminRoute><div>USERS</div></ProtectedAdminRoute>}
          />
        </Routes>
      </AdminAuthProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  get.mockResolvedValue(meAs());
});

describe('who is let in', () => {
  it('sends a visitor with no session to the sign-in screen', async () => {
    // No refresh cookie: the panel has nothing to rehydrate from.
    refreshAdminToken.mockResolvedValue(null);
    renderPanel('/dashboard');

    expect(await screen.findByText('SIGN IN SCREEN')).toBeInTheDocument();
    expect(screen.queryByText('DASHBOARD')).not.toBeInTheDocument();
  });

  it('shows the dashboard once the refresh cookie rehydrates a session', async () => {
    refreshAdminToken.mockResolvedValue('a-bearer-token');
    renderPanel('/dashboard');

    expect(await screen.findByText('DASHBOARD')).toBeInTheDocument();
    expect(screen.queryByText('SIGN IN SCREEN')).not.toBeInTheDocument();
  });

  it('does not flash the sign-in screen while the refresh is still in flight', async () => {
    // The bug this guards: rendering isAuthenticated=false before the refresh
    // resolves sends a perfectly valid session to /login for a frame.
    let settle;
    refreshAdminToken.mockReturnValue(new Promise((r) => { settle = r; }));
    renderPanel('/dashboard');

    // The panel in outline — it used to be the word "Loading…" alone on an
    // empty screen, and then the whole panel at once.
    expect(screen.getByRole('status', { name: /loading the control panel/i })).toBeInTheDocument();
    expect(screen.queryByText('SIGN IN SCREEN')).not.toBeInTheDocument();

    settle('a-bearer-token');
    expect(await screen.findByText('DASHBOARD')).toBeInTheDocument();
  });
});

describe('the two-factor enrolment gate', () => {
  it('parks an un-enrolled account on Security, whatever it asked for', async () => {
    refreshAdminToken.mockResolvedValue('a-bearer-token');
    get.mockResolvedValue(meAs({ twoFactorRequired: true, twoFactorEnabled: false }));

    renderPanel('/users');

    expect(await screen.findByText('SECURITY SCREEN')).toBeInTheDocument();
    expect(screen.queryByText('USERS')).not.toBeInTheDocument();
  });

  it('lets an enrolled account through even when 2FA is required', async () => {
    refreshAdminToken.mockResolvedValue('a-bearer-token');
    get.mockResolvedValue(meAs({ twoFactorRequired: true, twoFactorEnabled: true }));

    renderPanel('/users');
    expect(await screen.findByText('USERS')).toBeInTheDocument();
  });

  it('releases the account when refreshAdmin re-reads the profile', async () => {
    // This is the half that would strand somebody: enrolling works, the server
    // agrees, and the panel keeps them on Security because nothing re-read the
    // profile. Security.jsx calls refreshAdmin() after a successful enable, so
    // that is the mechanism exercised here rather than a remount — a remount
    // would pass even if refreshAdmin did nothing.
    refreshAdminToken.mockResolvedValue('a-bearer-token');
    get
      .mockResolvedValueOnce(meAs({ twoFactorRequired: true, twoFactorEnabled: false }))
      .mockResolvedValue(meAs({ twoFactorRequired: true, twoFactorEnabled: true }));

    render(
      <MemoryRouter initialEntries={['/users']}>
        <AdminAuthProvider>
          <Routes>
            <Route path="/security" element={<EnrolStandIn />} />
            <Route
              path="/users"
              element={<ProtectedAdminRoute><div>USERS</div></ProtectedAdminRoute>}
            />
          </Routes>
        </AdminAuthProvider>
      </MemoryRouter>
    );

    expect(await screen.findByText('SECURITY SCREEN')).toBeInTheDocument();

    // Still locked: trying to leave bounces straight back.
    await userEvent.click(screen.getByRole('button', { name: 'go to users' }));
    expect(await screen.findByText('SECURITY SCREEN')).toBeInTheDocument();
    expect(screen.queryByText('USERS')).not.toBeInTheDocument();

    // Enrol, and the same navigation is allowed through.
    await userEvent.click(screen.getByRole('button', { name: 'enrol' }));
    await userEvent.click(screen.getByRole('button', { name: 'go to users' }));
    expect(await screen.findByText('USERS')).toBeInTheDocument();
  });
});

describe('when the session ends server-side', () => {
  it('bounces to sign-in on the session-ended event', async () => {
    refreshAdminToken.mockResolvedValue('a-bearer-token');
    renderPanel('/dashboard');
    expect(await screen.findByText('DASHBOARD')).toBeInTheDocument();

    // What the 401 interceptor dispatches after the creator revokes sessions,
    // or a staff admin is demoted (AUDIT.md H-08, M-09).
    window.dispatchEvent(new Event('ndm:session-ended'));

    await waitFor(() => {
      expect(screen.getByText('SIGN IN SCREEN')).toBeInTheDocument();
    });
    expect(screen.queryByText('DASHBOARD')).not.toBeInTheDocument();
  });

  it('turns the gate on when the server says 2FA became required mid-session', async () => {
    refreshAdminToken.mockResolvedValue('a-bearer-token');
    get.mockResolvedValue(meAs({ twoFactorRequired: false, twoFactorEnabled: false }));

    renderPanel('/users');
    expect(await screen.findByText('USERS')).toBeInTheDocument();

    // ADMIN_2FA_REQUIRED switched on under a live session — which is exactly
    // what happened to this deployment on 2026-09-22.
    window.dispatchEvent(new Event('ndm:two-factor-required'));

    await waitFor(() => {
      expect(screen.getByText('SECURITY SCREEN')).toBeInTheDocument();
    });
  });
});

describe('a profile read that fails', () => {
  it('does not invent an authenticated profile (M-09)', async () => {
    // The regression: loadMe's catch used to setAdmin({ authenticated: true }),
    // which asserted the opposite of what had just happened and, carrying no
    // role, made the creator's own navigation disappear.
    refreshAdminToken.mockResolvedValue('a-bearer-token');
    get.mockRejectedValue(new Error('network blip'));

    renderPanel('/dashboard');

    // The bearer is real, so the panel stays in; what it must not do is
    // fabricate a profile to render from.
    expect(await screen.findByText('DASHBOARD')).toBeInTheDocument();
  });
});

describe('the dashboard while its numbers are on their way', () => {
  it('draws outlines rather than claims, then the numbers', async () => {
    refreshAdminToken.mockResolvedValue('a-bearer-token');
    const answers = {};
    get.mockImplementation((url) => {
      if (url === '/admin/stats' || url === '/admin/health') {
        return new Promise((resolve) => { answers[url] = resolve; });
      }
      return Promise.resolve(meAs());
    });

    render(
      <MemoryRouter>
        <AdminAuthProvider>
          <AdminDashboard />
        </AdminAuthProvider>
      </MemoryRouter>
    );

    // While nothing has answered, nothing may be claimed: this screen used to
    // say "No data", "No payments yet" and "checking" until the numbers came.
    await waitFor(() => expect(answers['/admin/stats']).toBeTypeOf('function'));
    expect(screen.queryByText('No data')).toBeNull();
    expect(screen.queryByText(/no payments yet/i)).toBeNull();
    expect(screen.queryByText(/checking/i)).toBeNull();
    expect(screen.getByRole('region', { name: /recent payments/i })).toHaveAttribute('aria-busy', 'true');

    answers['/admin/stats']({
      data: {
        ok: true,
        data: {
          totalUsers: 42, activeSubscriptions: 7, mrr: 35, pendingReviews: 2,
          newSignups: [], revenueSeries: [], planDistribution: [], recentActivity: [], recentPayments: [],
        },
      },
    });
    answers['/admin/health']({
      data: { ok: true, data: { database: 'ok', stripe: 'live', email: 'smtp', latencyMs: 12, uptimeSeconds: 600 } },
    });

    expect(await screen.findByText('42')).toBeInTheDocument();
    // An empty list is a real answer once it has arrived, and is said as one.
    expect(screen.getByText(/no payments yet/i)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /recent payments/i })).not.toHaveAttribute('aria-busy');
  });
});
