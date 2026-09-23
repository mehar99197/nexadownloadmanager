/**
 * What a Team member sees.
 *
 * The bug this file exists for: a member's own subscription row stays Free, so
 * the dashboard put them on "Free" with a "Start your free 7-day Pro trial"
 * banner — directly above a card saying they were on somebody's Team plan.
 * The server now reports the plan the account HAS (`viaTeam`), and these hold
 * the pages to it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { ToastProvider } from '../components/Toast';
import { ConfirmProvider } from '../components/ConfirmDialog';
import Dashboard from '../pages/Dashboard';

vi.mock('../api/client', () => {
  const api = { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() };
  return {
    default: api,
    unwrap: (res) => res?.data?.data,
    // AuthProvider subscribes to this; vitest throws on an export the mock
    // does not define. The real value is asserted in sessionEnded.test.jsx.
    SESSION_ENDED_EVENT: 'ndm:session-ended',
    setAccessToken: vi.fn(),
    clearAccessToken: vi.fn(),
    restoreSession: vi.fn(async () => false),
  };
});
import api from '../api/client';

// The dashboard reads the signed-in account from here; the member's shape is
// the whole point of the test, so it is supplied directly.
const authState = { user: null, refreshMe: vi.fn(async () => {}) };
vi.mock('../context/AuthContext', () => ({
  useAuth: () => authState,
  AuthProvider: ({ children }) => children,
}));

const envelope = (data) => Promise.resolve({ data: { ok: true, data } });

const TEAM_MEMBER = {
  id: 2, name: 'Member', email: 'member@example.test',
  subscription: {
    plan: 'team', status: 'active', seats: 5, licenseKey: 'NDM-TEAM-KEY0-0001',
    expiryDate: '2026-10-16T00:00:00.000Z', trial: false, trialEndsAt: null,
    cancelAtPeriodEnd: false, viaTeam: true, teamOwner: 'Ahmad',
  },
  team: { role: 'member', ownerName: 'Ahmad', plan: 'team' },
};

const renderDashboard = () => render(
  <MemoryRouter initialEntries={['/dashboard']}>
    <ToastProvider><ConfirmProvider><Dashboard /></ConfirmProvider></ToastProvider>
  </MemoryRouter>,
);

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
  api.delete.mockReset();
  authState.user = TEAM_MEMBER;
  api.get.mockImplementation((path) => {
    if (path === '/user/license') return envelope({
      licenseKey: 'NDM-TEAM-KEY0-0001', plan: 'team', status: 'active',
      trial: false, viaTeam: true, teamOwner: 'Ahmad',
      expiryDate: '2026-10-16T00:00:00.000Z',
    });
    if (path === '/user/devices') return envelope({ seats: 5, activeSeats: 0, seatsEnforced: true, devices: [] });
    if (path === '/team') return envelope({
      role: 'member', owner: { name: 'Ahmad', email: 'owner@example.test' },
      plan: 'team', status: 'active', usable: true, licenseKey: 'NDM-TEAM-KEY0-0001',
    });
    return envelope({});
  });
});

describe('Dashboard — a Team member', () => {
  it('shows the team plan, not Free, and never offers the trial they already have', async () => {
    renderDashboard();

    // The plan tile says Team, marked as coming from the team.
    expect(await screen.findByText(/via team/i)).toBeInTheDocument();
    expect(screen.getByText('Team')).toBeInTheDocument();

    // The trial banner is the thing that made this look broken.
    expect(screen.queryByRole('button', { name: /start your free 7-day pro trial/i })).toBeNull();
    expect(screen.queryByText(/try pro free for 7 days/i)).toBeNull();

    // …and the team card still explains where the plan comes from.
    expect(await screen.findByText(/you are on/i)).toHaveTextContent(/Ahmad/);
  });

  it('shows the team licence key card, not the Free "no key needed" one', async () => {
    renderDashboard();
    // The key is masked until "Show"; what matters here is which card renders.
    expect(await screen.findByRole('heading', { name: /license key/i })).toBeInTheDocument();
    expect(screen.getByText(/shared by/i)).toHaveTextContent(/Ahmad/);
    expect(screen.queryByTestId('account-signin-card')).toBeNull();
  });
});

describe('Dashboard — an account with no team', () => {
  it('still offers the trial', async () => {
    authState.user = {
      id: 3, name: 'Solo', email: 'solo@example.test',
      subscription: {
        plan: 'free', status: 'active', seats: 1, trial: false, trialEndsAt: null,
        viaTeam: false, teamOwner: null, cancelAtPeriodEnd: false,
      },
      team: null,
    };
    api.get.mockImplementation((path) => {
      if (path === '/user/license') return envelope({ licenseKey: 'NDM-FREE-0000-0001', plan: 'free', status: 'active', trial: false, viaTeam: false });
      if (path === '/user/devices') return envelope({ seats: 1, activeSeats: 0, seatsEnforced: false, devices: [] });
      if (path === '/team') return envelope({ role: 'none' });
      return envelope({});
    });
    renderDashboard();
    expect(await screen.findByText(/try pro free for 7 days/i)).toBeInTheDocument();
  });
});
