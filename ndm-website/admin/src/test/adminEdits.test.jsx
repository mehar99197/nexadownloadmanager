/**
 * The edit dialogs send what the admin changed, and only that.
 *
 * Users, Subscriptions and Releases used to post every field on every save.
 * The API read "present" as "changed", so ticking "Email verified" on a Team
 * customer reset their custom seats, correcting a trial's expiry ended the
 * trial, and a plain release save re-sent isLatest. The server now compares
 * against the stored row as well; these tests hold the panel's half.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
const put = vi.fn();
const post = vi.fn();

vi.mock('../api/client.js', () => ({
  default: {
    get: (...a) => get(...a),
    put: (...a) => put(...a),
    post: (...a) => post(...a),
    delete: vi.fn(),
  },
  unwrap: async (p) => {
    const res = await p;
    if (res?.data?.ok === false) throw new Error(res.data.error?.message || 'failed');
    return res?.data?.data;
  },
  TWO_FACTOR_REQUIRED_EVENT: 'ndm:two-factor-required',
  SESSION_ENDED_EVENT: 'ndm:session-ended',
}));

const { ConfirmProvider } = await import('../components/ConfirmDialog.jsx');
const { default: Users } = await import('../pages/Users.jsx');
const { default: Subscriptions } = await import('../pages/Subscriptions.jsx');
const { default: Releases } = await import('../pages/Releases.jsx');

const okBody = (data) => ({ data: { ok: true, data } });
const page = (ui) => render(<ConfirmProvider>{ui}</ConfirmProvider>);

beforeEach(() => {
  vi.clearAllMocks();
  put.mockResolvedValue(okBody({}));
});

async function openDialog(buttonName) {
  await userEvent.click(await screen.findByRole('button', { name: buttonName }));
  return screen.findByRole('dialog');
}

describe('Users: Manage', () => {
  const teamUser = {
    id: 7, name: 'Team Customer', email: 'team@example.test', role: 'user',
    banned: 0, email_verified: 0, plan: 'team',
    subscription: { plan: 'team', seats: 20 },
  };

  beforeEach(() => {
    get.mockResolvedValue(okBody({ users: [teamUser], totalCount: 1 }));
  });

  it('ticking "Email verified" sends only emailVerified, not the plan', async () => {
    page(<Users />);
    const dialog = await openDialog('Manage');
    const [, emailVerified] = within(dialog).getAllByRole('checkbox');
    await userEvent.click(emailVerified);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put).toHaveBeenCalledWith('/admin/users/7', { emailVerified: true });
  });

  it('a changed plan is sent', async () => {
    page(<Users />);
    const dialog = await openDialog('Manage');
    await userEvent.selectOptions(within(dialog).getByRole('combobox'), 'pro');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put).toHaveBeenCalledWith('/admin/users/7', { plan: 'pro' });
  });

  it('saving with nothing changed sends nothing', async () => {
    page(<Users />);
    const dialog = await openDialog('Manage');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(put).not.toHaveBeenCalled();
  });
});

describe('Subscriptions: Manage', () => {
  const trial = {
    id: 11, userName: 'Trial Customer', userEmail: 'trial@example.test', license_key: 'NEXA-TEST',
    plan: 'pro', status: 'active', seats: 1,
    expiry_date: '2030-01-15T12:00:00.000Z', trial_ends_at: '2030-01-15T12:00:00.000Z',
  };

  beforeEach(() => {
    get.mockResolvedValue(okBody({ subscriptions: [trial], totalCount: 1 }));
  });

  it('editing only the expiry sends only expiryDate', async () => {
    page(<Subscriptions />);
    const dialog = await openDialog('Manage');
    const expiry = dialog.querySelector('input[type="datetime-local"]');
    await userEvent.clear(expiry);
    await userEvent.type(expiry, '2030-02-01T09:30');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put).toHaveBeenCalledWith('/admin/subscriptions/11', {
      expiryDate: new Date('2030-02-01T09:30').toISOString(),
    });
  });

  it('changing only the plan leaves seats to the server', async () => {
    page(<Subscriptions />);
    const dialog = await openDialog('Manage');
    const [plan] = within(dialog).getAllByRole('combobox');
    await userEvent.selectOptions(plan, 'team');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put).toHaveBeenCalledWith('/admin/subscriptions/11', { plan: 'team' });
  });

  it('a changed seat count is sent as a number', async () => {
    page(<Subscriptions />);
    const dialog = await openDialog('Manage');
    const seats = within(dialog).getByRole('spinbutton');
    await userEvent.clear(seats);
    await userEvent.type(seats, '3');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put).toHaveBeenCalledWith('/admin/subscriptions/11', { seats: 3 });
  });
});

describe('Releases: Edit', () => {
  const latest = {
    id: 3, version: '2.0.0', changelog: 'notes', is_latest: 1,
    windows_url: '', linux_url: '', download_count: 0, published_at: '2026-01-01T00:00:00.000Z',
  };

  beforeEach(() => {
    get.mockResolvedValue(okBody([latest]));
  });

  it('a plain save of the latest release does not send isLatest', async () => {
    page(<Releases />);
    const dialog = await openDialog('Edit');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save release' }));

    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    const [url, body] = put.mock.calls[0];
    expect(url).toBe('/admin/releases/3');
    expect(body).not.toHaveProperty('isLatest');
  });

  it('toggling the box sends isLatest', async () => {
    page(<Releases />);
    const dialog = await openDialog('Edit');
    await userEvent.click(within(dialog).getByRole('checkbox'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save release' }));

    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put.mock.calls[0][1]).toMatchObject({ isLatest: false });
  });
});
