/**
 * Panel gaps: things the API could already do, or already said, that the panel
 * either could not reach or showed somewhere nobody was looking.
 *
 *  - the sharing queue: GET /subscriptions/flagged and the clear/resume
 *    routes existed with nothing calling them, so a wrongly suspended paying
 *    customer (whose row still reads "active") could be neither found nor
 *    released from the panel;
 *  - errors raised by a dialog's action were rendered in the page banner,
 *    underneath the dialog — for a contact reply whose email failed (502, but
 *    the reply was stored) that invited a second, duplicate send;
 *  - the signups chart promised thirty days and drew the last fourteen days
 *    that happened to have signups;
 *  - POST /users/:id/unlock had no button.
 *
 * The API module is mocked, as in guards.test.jsx: these are about what the
 * panel does with an answer.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
const post = vi.fn();
const put = vi.fn();

vi.mock('../api/client.js', () => ({
  default: {
    get: (...a) => get(...a),
    post: (...a) => post(...a),
    put: (...a) => put(...a),
    delete: vi.fn(),
  },
  unwrap: async (p) => {
    const res = await p;
    if (res?.data?.ok === false) throw new Error(res.data.error?.message || 'failed');
    return res?.data?.data;
  },
}));

vi.mock('../context/AdminAuthContext.jsx', () => ({
  useAdminAuth: () => ({ admin: { authenticated: true, twoFactorEnabled: true } }),
}));

const { ConfirmProvider } = await import('../components/ConfirmDialog.jsx');
const { default: Subscriptions } = await import('../pages/Subscriptions.jsx');
const { default: Contact } = await import('../pages/Contact.jsx');
const { default: Users } = await import('../pages/Users.jsx');
const { default: AdminDashboard } = await import('../pages/AdminDashboard.jsx');
const { default: Releases } = await import('../pages/Releases.jsx');

const ok = (data) => Promise.resolve({ data: { ok: true, data } });

/** What axios rejects with for a non-2xx envelope. */
function httpError(status, code, message) {
  const err = new Error(`Request failed with status code ${status}`);
  err.response = { status, data: { ok: false, error: { code, message } } };
  return err;
}

function renderPage(page) {
  return render(<MemoryRouter><ConfirmProvider>{page}</ConfirmProvider></MemoryRouter>);
}

/** Route GETs by path; anything unlisted answers an empty envelope. */
function routeGets(table) {
  get.mockImplementation((url) => {
    for (const [prefix, answer] of table) {
      if (url === prefix) return typeof answer === 'function' ? answer() : ok(answer);
    }
    return ok({});
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the sharing queue on Subscriptions', () => {
  const SUSPENDED = {
    id: 7, email: 'paying@example.test', plan: 'pro', status: 'active', seats: 1,
    sharing_level: 'suspected', sharing_devices: 14, sharing_reason: '14 devices in 30 days',
    sharing_checked_at: '2026-09-20T10:00:00.000Z', sharing_suspended_at: '2026-09-20T10:00:00.000Z',
    sharing_exempt: 0,
  };

  it('lists a suspended licence and lifts the suspension after confirmation, then refreshes', async () => {
    let flagged = [SUSPENDED];
    routeGets([
      ['/admin/subscriptions', { subscriptions: [], totalCount: 0 }],
      ['/admin/subscriptions/flagged', () => ok({
        subscriptions: flagged,
        thresholds: { windowDays: 30, perSeat: { watch: 4, suspected: 6, suspend: 10 } },
      })],
    ]);
    post.mockImplementation(() => { flagged = []; return ok({ cleared: true }); });

    renderPage(<Subscriptions />);
    const queue = (await screen.findByRole('heading', { name: 'Flagged for sharing' })).closest('section');
    expect(await within(queue).findByText('paying@example.test')).toBeInTheDocument();
    expect(within(queue).getByText('suspected')).toBeInTheDocument();
    expect(within(queue).getByText('14')).toBeInTheDocument();
    expect(within(queue).getByText('14 devices in 30 days')).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(within(queue).getByRole('button', { name: 'Clear suspension' }));
    // Nothing happens until the dialog is answered.
    expect(post).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Clear suspension' }));

    await waitFor(() => expect(post).toHaveBeenCalledWith('/admin/subscriptions/7/sharing/clear'));
    expect(await within(queue).findByText(/Nothing flagged/)).toBeInTheDocument();
    expect(get.mock.calls.filter(([url]) => url === '/admin/subscriptions/flagged').length).toBe(2);
  });

  it('offers Resume enforcement on an exempted licence, and a cancelled dialog does nothing', async () => {
    const exempt = { ...SUSPENDED, id: 9, sharing_suspended_at: null, sharing_level: 'watch', sharing_exempt: 1 };
    routeGets([
      ['/admin/subscriptions', { subscriptions: [], totalCount: 0 }],
      ['/admin/subscriptions/flagged', { subscriptions: [exempt], thresholds: null }],
    ]);
    post.mockImplementation(() => ok({ resumed: true }));

    renderPage(<Subscriptions />);
    const queue = (await screen.findByRole('heading', { name: 'Flagged for sharing' })).closest('section');
    const user = userEvent.setup();

    await user.click(await within(queue).findByRole('button', { name: 'Resume enforcement' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    expect(post).not.toHaveBeenCalled();

    await user.click(within(queue).getByRole('button', { name: 'Resume enforcement' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Resume enforcement' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/admin/subscriptions/9/sharing/resume'));
  });
});

describe('errors raised inside a dialog are shown inside it', () => {
  it('a contact reply whose email failed: the reason is in the dialog, the thread is re-read, the box is emptied', async () => {
    const message = {
      id: 5, name: 'Visitor', email: 'visitor@example.test', topic: 'general', status: 'open',
      message: 'Hello?', created_at: '2026-09-20T10:00:00.000Z', reply_count: 0, email_delivered: 1,
    };
    let replies = [];
    routeGets([
      ['/admin/contact', { messages: [message], totalCount: 1, stats: { total: 1, unread: 0, awaiting: 1, replied: 0 } }],
      ['/admin/contact/5', () => ok({ message, replies })],
    ]);
    post.mockImplementation(() => {
      // The server stores the reply BEFORE answering 502.
      replies = [{ id: 1, admin_name: 'Staff', body: 'We are on it.', delivered: 0, delivery_error: 'SMTP down', created_at: '2026-09-20T11:00:00.000Z' }];
      return Promise.reject(httpError(502, 'EMAIL_SEND_FAILED',
        'The reply was saved but could not be emailed. Check the SMTP settings and try again.'));
    });

    renderPage(<Contact />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Open' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Your reply'), 'We are on it.');
    await user.click(within(dialog).getByRole('button', { name: 'Send reply' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent(/saved but could not be emailed/);
    expect(await within(dialog).findByText('not delivered')).toBeInTheDocument();
    expect(within(dialog).getByText('Delivery error: SMTP down')).toBeInTheDocument();
    expect(get.mock.calls.filter(([url]) => url === '/admin/contact/5').length).toBe(2);
    // Emptied: a second press cannot send the same text again by accident.
    expect(within(dialog).getByLabelText('Your reply')).toHaveValue('');
    expect(within(dialog).getByRole('button', { name: 'Send reply' })).toBeDisabled();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('a failed save on the Users edit dialog says why inside the dialog', async () => {
    routeGets([
      ['/admin/users', { users: [{ id: 3, name: 'Cust', email: 'cust@example.test', role: 'user', plan: 'free', banned: 0, email_verified: 1 }], totalCount: 1 }],
    ]);
    put.mockImplementation(() => Promise.reject(httpError(403, 'FORBIDDEN', 'Only the creator can modify a control-panel account')));

    renderPage(<Users />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Manage' }));
    const dialog = await screen.findByRole('dialog');
    // A save with nothing changed sends nothing, so change something.
    await user.selectOptions(within(dialog).getByLabelText('Subscription plan'), 'pro');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Only the creator can modify a control-panel account');
    expect(put).toHaveBeenCalledWith('/admin/users/3', { plan: 'pro' });
  });

  it('a failed save on the Subscriptions edit dialog says why inside the dialog', async () => {
    routeGets([
      ['/admin/subscriptions', { subscriptions: [{ id: 4, userName: 'Cust', userEmail: 'cust@example.test', plan: 'pro', status: 'active', seats: 1, license_key: 'NEXA-X' }], totalCount: 1 }],
      ['/admin/subscriptions/flagged', { subscriptions: [], thresholds: null }],
    ]);
    put.mockImplementation(() => Promise.reject(httpError(400, 'VALIDATION_ERROR', 'Seats must be at least 1')));

    renderPage(<Subscriptions />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Manage' }));
    const dialog = await screen.findByRole('dialog');
    // A save with nothing changed sends nothing, so change something.
    const seats = within(dialog).getByLabelText('Seats');
    await user.clear(seats);
    await user.type(seats, '3');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Seats must be at least 1');
    expect(put).toHaveBeenCalledWith('/admin/subscriptions/4', { seats: 3 });
  });
});

describe('the signups chart', () => {
  it('draws the thirty days its caption names, with a zero for a day nobody signed up', async () => {
    const today = new Date().toISOString().slice(0, 10);
    routeGets([
      ['/admin/stats', {
        totalUsers: 3, activeSubscriptions: 1, activeTrials: 2, mrr: 0, mrrSubscriptions: 0, pendingReviews: 0,
        newSignups: [{ date: '2020-01-01T00:00:00.000Z', count: 9 }, { date: `${today}T00:00:00.000Z`, count: 3 }],
        revenueSeries: [], planDistribution: [], recentActivity: [], recentPayments: [],
      }],
      ['/admin/health', { database: 'connected', stripe: 'disabled', email: 'mock', latencyMs: 1, uptimeSeconds: 60 }],
    ]);

    renderPage(<AdminDashboard />);
    const section = (await screen.findByRole('heading', { name: 'New signups' })).closest('section');
    await waitFor(() => expect(section.querySelectorAll('[title]').length).toBe(30));
    const bars = [...section.querySelectorAll('[title]')].map((el) => el.getAttribute('title'));
    // Oldest first, today last; a day outside the window is not drawn at all.
    expect(bars.at(-1)).toMatch(/: 3$/);
    expect(bars.filter((t) => t.endsWith(': 0'))).toHaveLength(29);
    expect(section).toHaveTextContent('3 in total');

    // And the tiles say what they count.
    expect(screen.getByText(/trials excluded · 2 on trial/)).toBeInTheDocument();
    expect(screen.getByText(/0 Stripe-billed plans/)).toBeInTheDocument();
  });
});

describe('unlocking a customer who is locked out of sign-in', () => {
  it('shows the lock and lifts it after confirmation', async () => {
    let lockedUntil = '2099-01-01T00:00:00.000Z';
    routeGets([
      ['/admin/users', () => ok({
        users: [
          { id: 3, name: 'Locked', email: 'locked@example.test', role: 'user', plan: 'free', banned: 0, email_verified: 1, signInLockedUntil: lockedUntil },
          { id: 4, name: 'Fine', email: 'fine@example.test', role: 'user', plan: 'free', banned: 0, email_verified: 1, signInLockedUntil: null },
        ],
        totalCount: 2,
      })],
    ]);
    post.mockImplementation(() => { lockedUntil = null; return ok({ unlocked: true, wasLocked: true }); });

    renderPage(<Users />);
    const user = userEvent.setup();
    expect(await screen.findByText('sign-in locked')).toBeInTheDocument();
    // Only on the locked account.
    const unlock = screen.getAllByRole('button', { name: 'Unlock sign-in' });
    expect(unlock).toHaveLength(1);

    await user.click(unlock[0]);
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Unlock sign-in' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/admin/users/3/unlock'));
    await waitFor(() => expect(screen.queryByText('sign-in locked')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Unlock sign-in' })).not.toBeInTheDocument();
  });

  it('says so when the lock is on the authenticator-code step, not the password', async () => {
    routeGets([
      ['/admin/users', () => ok({
        users: [
          { id: 5, name: 'Codes', email: 'codes@example.test', role: 'user', plan: 'free', banned: 0, email_verified: 1, signInLockedUntil: '2099-01-01T00:00:00.000Z', signInLockReason: 'two_factor' },
        ],
        totalCount: 1,
      })],
    ]);

    renderPage(<Users />);
    const user = userEvent.setup();
    expect(await screen.findByText('sign-in locked')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Unlock sign-in' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/wrong authenticator codes/);
    expect(dialog).not.toHaveTextContent(/wrong passwords/);
  });
});

describe('the release external-URL fields', () => {
  it('sends only the URL fields that were changed, and an emptied one as a clear', async () => {
    routeGets([
      ['/admin/releases', [
        { id: 1, version: '1.0.0', changelog: '', is_latest: 1, windows_url: 'https://cdn.example.test/a.exe', linux_url: '' },
      ]],
    ]);
    put.mockImplementation(() => ok({}));

    renderPage(<Releases />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /external download URL/ }));

    // Opened, touched nothing: neither URL is sent (the empty Linux one used to
    // go out as '' and be refused).
    await user.click(within(dialog).getByRole('button', { name: 'Save release' }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put.mock.calls[0][1]).not.toHaveProperty('windowsUrl');
    expect(put.mock.calls[0][1]).not.toHaveProperty('linuxUrl');

    // Emptying the stored Windows URL sends '' — the way to clear it.
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const again = await screen.findByRole('dialog');
    await user.click(within(again).getByRole('button', { name: /external download URL/ }));
    await user.clear(within(again).getByLabelText('Windows URL'));
    await user.click(within(again).getByRole('button', { name: 'Save release' }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(2));
    expect(put.mock.calls[1][1]).toMatchObject({ windowsUrl: '' });
    expect(put.mock.calls[1][1]).not.toHaveProperty('linuxUrl');
  });
});
