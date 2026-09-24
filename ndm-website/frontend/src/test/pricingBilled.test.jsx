/**
 * Pricing must not start a second subscription for an account Stripe
 * already bills.
 *
 * A paying Pro customer saw "Get Team" and got a checkout. A second checkout
 * makes a second subscription, and both charge every month. The server now
 * refuses it (409 ALREADY_SUBSCRIBED), because plan changes belong to the
 * subscription that already exists, in Stripe's portal behind Billing. So the
 * page sends a billed account there. If its copy of the account is stale and
 * the server says so, the page says so as well, with the same link.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { ToastProvider } from '../components/Toast';
import Pricing from '../pages/Pricing';
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

const authState = { user: null, isAuthenticated: false, refreshMe: vi.fn(async () => {}) };

vi.mock('../context/AuthContext', () => ({
  useAuth: () => authState,
  AuthProvider: ({ children }) => children,
}));

const envelope = (data) => Promise.resolve({ data: { ok: true, data } });

const PLANS = {
  free: { id: 'free', name: 'Free', price: 0, features: [] },
  pro: { id: 'pro', name: 'Pro', monthly: 5, yearly: 45, features: [] },
  team: { id: 'team', name: 'Team', monthly: 15, yearly: 135, features: [] },
  billing: 'live',
};

/** A Pro account. `billed` is what /user/me reports: true only for a live Stripe subscription. */
const signInAsPro = (billed) => {
  authState.user = {
    id: 1, name: 'Customer', email: 'customer@example.test',
    subscription: {
      plan: 'pro', status: 'active', seats: 1, trial: false, trialEndsAt: null,
      cancelAtPeriodEnd: false, viaTeam: false, billed,
    },
  };
  authState.isAuthenticated = true;
};

const renderPricing = () => render(
  <MemoryRouter initialEntries={['/pricing']}>
    <ToastProvider><Pricing /></ToastProvider>
  </MemoryRouter>,
);

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
  authState.refreshMe.mockClear();
  forgetAllReads();
  api.get.mockImplementation((path) => (path === '/subscription/plans' ? envelope(PLANS) : envelope({})));
});

describe('Pricing — an account Stripe already bills', () => {
  it('sends Team to Billing instead of opening a second checkout', async () => {
    signInAsPro(true);
    renderPricing();

    const manage = await screen.findByRole('link', { name: 'Manage billing' });
    expect(manage).toHaveAttribute('href', '/billing');
    expect(screen.queryByRole('button', { name: 'Get Team' })).toBeNull();

    await userEvent.click(manage);
    expect(api.post).not.toHaveBeenCalled();
  });

  it('still sells Team to a Pro account nobody is billing for (granted, not bought)', async () => {
    signInAsPro(false);
    api.post.mockImplementation(() => envelope({ url: null }));
    renderPricing();

    await userEvent.click(await screen.findByRole('button', { name: 'Get Team' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/subscription/checkout', expect.objectContaining({ plan: 'team' }),
    ));
  });

  it('answers a 409 ALREADY_SUBSCRIBED with a way to Billing, and refreshes the account', async () => {
    // What the page knows is out of date: the subscription started elsewhere.
    signInAsPro(false);
    api.post.mockRejectedValue({
      response: {
        status: 409,
        data: {
          ok: false,
          error: {
            code: 'ALREADY_SUBSCRIBED',
            message: 'You already have an active subscription. To switch plans or billing cycle, use "Manage billing" on the Billing page.',
          },
        },
      },
    });
    renderPricing();

    await userEvent.click(await screen.findByRole('button', { name: 'Get Team' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/already has a paid plan/i);
    expect(alert.querySelector('a[href="/billing"]')).not.toBeNull();
    expect(authState.refreshMe).toHaveBeenCalled();
  });

  it('keeps any other checkout failure as the plain error it was', async () => {
    signInAsPro(false);
    api.post.mockRejectedValue({
      response: { status: 400, data: { ok: false, error: { code: 'INVALID_COUPON', message: 'That code is not valid' } } },
    });
    renderPricing();

    await userEvent.click(await screen.findByRole('button', { name: 'Get Team' }));

    expect(await screen.findByText('That code is not valid')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(authState.refreshMe).not.toHaveBeenCalled();
  });
});
