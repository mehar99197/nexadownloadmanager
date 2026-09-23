/**
 * What the dashboard promises about a plan.
 *
 * Two things it used to get wrong, both seen on the live site: every plan's
 * date read "Expires" while Billing called the same date "Renews" — and only a
 * Stripe subscription renews at all; and with billing switched off it still
 * offered "Upgrade to Team", a link to a Team card that said "Coming soon".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { ToastProvider } from '../components/Toast';
import { ConfirmProvider } from '../components/ConfirmDialog';
import Dashboard from '../pages/Dashboard';
import { forgetAllReads } from '../api/reads';

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

const authState = { user: null, refreshMe: vi.fn(async () => {}) };
vi.mock('../context/AuthContext', () => ({
  useAuth: () => authState,
  AuthProvider: ({ children }) => children,
}));

const envelope = (data) => Promise.resolve({ data: { ok: true, data } });

const proUser = (subscription) => ({
  id: 1, name: 'Owner', email: 'owner@example.test',
  subscription: {
    plan: 'pro', status: 'active', seats: 1, expiryDate: '2026-10-15T00:00:00.000Z',
    trial: false, trialEndsAt: null, cancelAtPeriodEnd: false, viaTeam: false, billed: false,
    ...subscription,
  },
  team: null,
});

function serve({ billing, license }) {
  api.get.mockImplementation((path) => {
    if (path === '/subscription/plans') return envelope({ billing });
    if (path === '/user/license') return envelope({
      licenseKey: 'NDM-TEST-KEY0-0001', plan: 'pro', status: 'active',
      trial: false, viaTeam: false, expiryDate: '2026-10-15T00:00:00.000Z',
      ...license,
    });
    if (path === '/user/devices') return envelope({ seats: 1, activeSeats: 0, seatsEnforced: true, devices: [] });
    if (path === '/team') return envelope({ role: 'none' });
    return envelope({});
  });
}

const renderDashboard = () => render(
  <MemoryRouter initialEntries={['/dashboard']}>
    <ToastProvider><ConfirmProvider><Dashboard /></ConfirmProvider></ToastProvider>
  </MemoryRouter>,
);

beforeEach(() => {
  api.get.mockReset();
  forgetAllReads();
});

describe('Dashboard — the date on the key', () => {
  it('says "Active until" for a plan with no subscription behind it', async () => {
    authState.user = proUser({ billed: false });
    serve({ billing: 'disabled', license: { billed: false } });
    renderDashboard();
    expect(await screen.findByText(/active until:/i)).toBeInTheDocument();
    expect(screen.queryByText(/renews:/i)).toBeNull();
    expect(screen.queryByText(/expires:/i)).toBeNull();
  });

  it('says "Renews" only for a billed plan', async () => {
    authState.user = proUser({ billed: true });
    serve({ billing: 'live', license: { billed: true } });
    renderDashboard();
    expect(await screen.findByText(/renews:/i)).toBeInTheDocument();
  });

  it('says "Ends" once a billed plan has been cancelled', async () => {
    authState.user = proUser({ billed: true, cancelAtPeriodEnd: true });
    serve({ billing: 'live', license: { billed: true } });
    renderDashboard();
    expect(await screen.findByText(/^ends:/i)).toBeInTheDocument();
  });
});

describe('Dashboard — upgrades only while something can be bought', () => {
  it('offers to compare plans, not to upgrade, when billing is off', async () => {
    authState.user = proUser();
    serve({ billing: 'disabled', license: {} });
    renderDashboard();
    expect(await screen.findByRole('link', { name: /compare plans/i })).toHaveAttribute('href', '/pricing');
    expect(screen.queryByRole('link', { name: /upgrade to team/i })).toBeNull();
  });

  it('offers the Team upgrade when billing is live', async () => {
    authState.user = proUser({ billed: true });
    serve({ billing: 'live', license: { billed: true } });
    renderDashboard();
    expect(await screen.findByRole('link', { name: /upgrade to team/i })).toBeInTheDocument();
  });

  it('gives a trial no "Upgrade" button while nothing can be bought', async () => {
    authState.user = proUser({ trial: true, trialEndsAt: '2026-09-30T00:00:00.000Z' });
    serve({ billing: 'disabled', license: { trial: true } });
    renderDashboard();
    expect(await screen.findByText('Pro trial')).toBeInTheDocument();
    expect(await screen.findAllByRole('link', { name: /compare plans/i })).not.toHaveLength(0);
    expect(screen.queryByRole('link', { name: /^upgrade$/i })).toBeNull();
  });
});
