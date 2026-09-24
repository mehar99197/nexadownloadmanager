/**
 * Billing — ending a trial.
 *
 * The rule this holds: a trial gets "End trial now" (nothing is billed, so the
 * only thing cancelling can mean is stopping it), a paid plan gets "Cancel
 * subscription" instead, and neither appears on Free. The confirm dialog has to
 * say the irreversible part out loud — the trial cannot be started again —
 * because the button is one click from the account's only trial.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { ToastProvider } from '../components/Toast';
import { ConfirmProvider } from '../components/ConfirmDialog';
import Billing from '../pages/Billing';

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

const envelope = (data) => Promise.resolve({ data: { ok: true, data } });

const renderBilling = (status) => {
  api.get.mockImplementation((path) => {
    if (path === '/user/billing') return envelope({ payments: [] });
    if (path === '/subscription/status') return envelope(status);
    return envelope({});
  });
  return render(
    <MemoryRouter initialEntries={['/billing']}>
      <ToastProvider><ConfirmProvider><Billing /></ConfirmProvider></ToastProvider>
    </MemoryRouter>,
  );
};

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
});

describe('Billing — a running trial', () => {
  const trial = {
    plan: 'pro', status: 'active', trial: true,
    trialEndsAt: '2026-10-01T00:00:00.000Z',
    expiryDate: '2026-10-01T00:00:00.000Z', seats: 1, cancelAtPeriodEnd: false,
  };

  it('offers to end the trial, warns that it cannot come back, and ends it', async () => {
    api.post.mockImplementation((path) => (path === '/subscription/trial/cancel'
      ? envelope({ plan: 'free', status: 'active', trial: false, seats: 1 })
      : Promise.reject(new Error('unexpected'))));

    renderBilling(trial);

    const end = await screen.findByTestId('end-trial');
    expect(end).toHaveTextContent(/end trial now/i);
    // A trial is not a subscription with a renewal to call off.
    expect(screen.queryByRole('button', { name: /cancel subscription/i })).toBeNull();

    await userEvent.click(end);
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/cannot be started again/i);
    expect(dialog).toHaveTextContent(/returns to Free/i);

    // The page button and the dialog's confirm share a label on purpose —
    // click the one inside the dialog.
    await userEvent.click(within(dialog).getByRole('button', { name: /^end trial now$/i }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/subscription/trial/cancel'));
  });

  it('keeps the trial when the dialog is dismissed', async () => {
    renderBilling(trial);
    await userEvent.click(await screen.findByTestId('end-trial'));
    await userEvent.click(await screen.findByRole('button', { name: /keep my trial/i }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(api.post).not.toHaveBeenCalled();
  });
});

describe('Billing — the other plans', () => {
  it('a paid plan cancels its subscription instead', async () => {
    renderBilling({
      plan: 'pro', status: 'active', trial: false, billed: true,
      expiryDate: '2027-01-01T00:00:00.000Z', seats: 1, cancelAtPeriodEnd: false,
    });
    expect(await screen.findByRole('button', { name: /cancel subscription/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /manage billing/i })).toBeInTheDocument();
    expect(screen.getByText('Renews')).toBeInTheDocument();
    expect(screen.queryByTestId('end-trial')).toBeNull();
  });

  // An admin-granted plan has no Stripe subscription behind it. It used to read
  // "Renews" beside an empty payment history, with a cancel button and a portal
  // button that answered an error.
  it('a plan granted without a payment says when it ends, and offers nothing to cancel', async () => {
    renderBilling({
      plan: 'pro', status: 'active', trial: false, billed: false,
      expiryDate: '2026-10-15T00:00:00.000Z', seats: 1, cancelAtPeriodEnd: false,
    });
    expect(await screen.findByText(/this plan is not billed/i)).toBeInTheDocument();
    expect(screen.getByText('Active until')).toBeInTheDocument();
    expect(screen.queryByText('Renews')).toBeNull();
    expect(screen.queryByRole('button', { name: /cancel subscription/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /manage billing/i })).toBeNull();
  });

  it('a Team member sees whose plan it is, with nothing to pay or cancel', async () => {
    renderBilling({
      plan: 'team', status: 'active', trial: false, seats: 5,
      expiryDate: '2026-10-16T00:00:00.000Z', cancelAtPeriodEnd: false,
      viaTeam: true, teamOwner: 'Ahmad',
    });
    expect(await screen.findByText(/this plan comes from/i)).toHaveTextContent(/Ahmad/);
    // A member can neither pay for nor stop somebody else's subscription.
    expect(screen.queryByRole('button', { name: /cancel subscription/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /manage billing/i })).toBeNull();
    expect(screen.queryByTestId('end-trial')).toBeNull();
    // …and it is not the Free plan either.
    expect(screen.queryByText(/never expires and has nothing to cancel/i)).toBeNull();
  });

  it('Free has nothing to end', async () => {
    renderBilling({ plan: 'free', status: 'active', trial: false, seats: 1, cancelAtPeriodEnd: false });
    expect(await screen.findByText(/nothing to cancel/i)).toBeInTheDocument();
    expect(screen.queryByTestId('end-trial')).toBeNull();
  });

  // Free's stored expiry is a century out. Printed, it read "Expires
  // <2126>" right above "The free plan never expires".
  it('Free prints no expiry date', async () => {
    renderBilling({
      plan: 'free', status: 'active', trial: false, seats: 1, cancelAtPeriodEnd: false,
      expiryDate: '2126-09-23T00:00:00.000Z',
    });
    expect(await screen.findByText(/never expires/i)).toBeInTheDocument();
    expect(screen.queryByText('Expires')).toBeNull();
    expect(screen.queryByText(/2126/)).toBeNull();
  });
});
