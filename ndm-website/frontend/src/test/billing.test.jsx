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
      plan: 'pro', status: 'active', trial: false,
      expiryDate: '2027-01-01T00:00:00.000Z', seats: 1, cancelAtPeriodEnd: false,
    });
    expect(await screen.findByRole('button', { name: /cancel subscription/i })).toBeInTheDocument();
    expect(screen.queryByTestId('end-trial')).toBeNull();
  });

  it('Free has nothing to end', async () => {
    renderBilling({ plan: 'free', status: 'active', trial: false, seats: 1, cancelAtPeriodEnd: false });
    expect(await screen.findByText(/nothing to cancel/i)).toBeInTheDocument();
    expect(screen.queryByTestId('end-trial')).toBeNull();
  });
});
