import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { AuthProvider } from '../context/AuthContext';
import { ToastProvider } from '../components/Toast';
import { ConfirmProvider } from '../components/ConfirmDialog';
import Activate, { normaliseCode } from '../pages/Activate';
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

const envelope = (data) => Promise.resolve({ data: { ok: true, data } });
const failure = (status, code, message) => {
  const err = new Error(message);
  err.response = { status, data: { ok: false, error: { code, message } } };
  return Promise.reject(err);
};

const renderAt = (path, ui) => render(
  <MemoryRouter initialEntries={[path]}>
    <ToastProvider><ConfirmProvider><AuthProvider>{ui}</AuthProvider></ConfirmProvider></ToastProvider>
  </MemoryRouter>,
);

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
  api.delete.mockReset();
});

describe('normaliseCode', () => {
  it('accepts what a person types and produces what the server stores', () => {
    expect(normaliseCode('abcd1234')).toBe('ABCD-1234');
    expect(normaliseCode(' abcd-1234 ')).toBe('ABCD-1234');
    expect(normaliseCode('ab')).toBe('AB');
    expect(normaliseCode('')).toBe('');
  });
});

describe('/activate — connecting the desktop app', () => {
  it('shows which machine is asking and approves it', async () => {
    api.get.mockImplementation((path) => {
      if (path === '/device/code/ABCD-1234')
        return envelope({ userCode: 'ABCD-1234', deviceName: 'Office laptop (Windows 11)', appVersion: '0.3.0', requestedAt: new Date().toISOString() });
      return failure(404, 'NOT_FOUND', 'no');
    });
    api.post.mockImplementation((path) => (path === '/device/approve' ? envelope({ approved: true }) : failure(400, 'BAD', 'no')));

    renderAt('/activate?code=abcd1234', <Activate />);

    const device = await screen.findByTestId('activate-device');
    expect(device).toHaveTextContent('Office laptop (Windows 11)');
    expect(device).toHaveTextContent('Nexa 0.3.0');
    expect(screen.getByLabelText(/code shown in the app/i)).toHaveValue('ABCD-1234');

    await userEvent.click(screen.getByRole('button', { name: /approve this computer/i }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/device/approve', { user_code: 'ABCD-1234' }));
    expect(await screen.findByTestId('activate-approved')).toHaveTextContent(/signed in/i);
  });

  it('says so when the code has expired, and denies on request', async () => {
    api.get.mockImplementation((path) => (path === '/device/code/ZZZZ-9999'
      ? failure(404, 'CODE_NOT_FOUND', 'That code is not waiting for approval — it may have expired.')
      : envelope({ userCode: 'ABCD-1234', deviceName: 'Home desktop', appVersion: null, requestedAt: new Date().toISOString() })));
    api.post.mockImplementation((path) => (path === '/device/deny' ? envelope({ denied: true }) : failure(400, 'BAD', 'no')));

    renderAt('/activate?code=ZZZZ-9999', <Activate />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/expired/i);
    expect(screen.getByRole('button', { name: /approve this computer/i })).toBeDisabled();

    // Typing a live code looks it up again.
    const input = screen.getByLabelText(/code shown in the app/i);
    await userEvent.clear(input);
    await userEvent.type(input, 'abcd1234');
    expect(await screen.findByTestId('activate-device')).toHaveTextContent('Home desktop');
    await userEvent.click(screen.getByRole('button', { name: /^deny$/i }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/device/deny', { user_code: 'ABCD-1234' }));
    expect(await screen.findByTestId('activate-denied')).toBeInTheDocument();
  });
});

describe('/activate — the computer on screen is the one Approve approves', () => {
  const device = (userCode, deviceName) => ({ data: { ok: true, data: {
    userCode, deviceName, appVersion: null, requestedAt: new Date().toISOString(),
  } } });

  it('ignores a slower reply for a code that has since been replaced', async () => {
    // The first code's lookup is held; a second code pasted over it answers
    // at once. The held reply then lands last and must not repaint the card.
    let releaseFirst;
    api.get.mockImplementation((path) => {
      if (path === '/device/code/AAAA-1111')
        return new Promise((resolve) => { releaseFirst = () => resolve(device('AAAA-1111', 'Stranger PC')); });
      if (path === '/device/code/BBBB-2222') return Promise.resolve(device('BBBB-2222', 'My laptop'));
      return failure(404, 'NOT_FOUND', 'no');
    });
    api.post.mockImplementation(() => envelope({ approved: true }));

    renderAt('/activate?code=AAAA1111', <Activate />);
    await waitFor(() => expect(releaseFirst).toBeTypeOf('function'));

    const input = screen.getByLabelText(/code shown in the app/i);
    await userEvent.clear(input);
    await userEvent.paste('BBBB2222');
    expect(await screen.findByTestId('activate-device')).toHaveTextContent('My laptop');

    await act(async () => { releaseFirst(); });

    expect(screen.getByTestId('activate-device')).toHaveTextContent('My laptop');
    expect(screen.queryByText('Stranger PC')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /approve this computer/i }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/device/approve', { user_code: 'BBBB-2222' }));
  });

  it('an incomplete code shows no computer, and nothing can be approved', async () => {
    api.get.mockImplementation((path) => (path === '/device/code/ABCD-1234'
      ? Promise.resolve(device('ABCD-1234', 'Office laptop'))
      : failure(404, 'NOT_FOUND', 'no')));

    renderAt('/activate?code=ABCD1234', <Activate />);
    expect(await screen.findByTestId('activate-device')).toHaveTextContent('Office laptop');

    await userEvent.type(screen.getByLabelText(/code shown in the app/i), '{Backspace}');

    expect(screen.queryByTestId('activate-device')).toBeNull();
    expect(screen.getByRole('button', { name: /approve this computer/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^deny$/i })).toBeDisabled();
  });
});

describe('Dashboard — the Free plan has no key, devices sign out', () => {
  it('replaces the key card with the sign-in explainer on Free and lists signed-in machines', async () => {
    api.get.mockImplementation((path) => {
      if (path === '/user/license') return envelope({ licenseKey: 'NDM-AAAA-BBBB-CCCC', plan: 'free', status: 'active', trial: false, viaTeam: false });
      if (path === '/user/devices') return envelope({
        seats: 1, activeSeats: 1, seatsEnforced: false,
        devices: [
          { id: 4, tokenId: 9, shortId: 'aaaaaaaa', name: 'Office laptop', signedIn: true, appVersion: '0.3.0', active: true, lastSeenAt: new Date().toISOString() },
          { id: 5, tokenId: null, shortId: 'bbbbbbbb', name: 'Old PC', signedIn: false, appVersion: null, active: true, lastSeenAt: new Date().toISOString() },
        ],
      });
      return failure(404, 'NOT_FOUND', 'no');
    });
    api.delete.mockResolvedValue({ data: { ok: true, data: { signedOut: true } } });

    renderAt('/dashboard', <Dashboard />);

    expect(await screen.findByTestId('account-signin-card')).toHaveTextContent(/no license key needed/i);
    expect(screen.queryByText('NDM-AAAA-BBBB-CCCC')).toBeNull();
    expect(screen.queryByText(/•••/)).toBeNull();

    const list = await screen.findByTestId('device-list');
    const rows = within(list).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Signed in');
    expect(rows[0]).toHaveTextContent('Nexa 0.3.0');
    expect(rows[1]).toHaveTextContent(/activated with a license key/i);
    expect(screen.queryByText(/in use$/)).toBeNull();   // no seat badge on Free

    await userEvent.click(within(rows[0]).getByRole('button', { name: /sign out/i }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/user/devices/tokens/9'));
    await userEvent.click(within(rows[1]).getByRole('button', { name: /free this seat/i }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/user/devices/5'));
  });

  it('keeps the key on a paid plan, demoted to manual activation', async () => {
    api.get.mockImplementation((path) => {
      if (path === '/user/license') return envelope({ licenseKey: 'NDM-AAAA-BBBB-CCCC', plan: 'pro', status: 'active', trial: false, viaTeam: false, expiryDate: '2027-01-01T00:00:00.000Z' });
      if (path === '/user/devices') return envelope({ seats: 1, activeSeats: 0, seatsEnforced: true, devices: [] });
      return failure(404, 'NOT_FOUND', 'no');
    });
    renderAt('/dashboard', <Dashboard />);
    expect(await screen.findByText(/only for activating by hand/i)).toBeInTheDocument();
    expect(screen.getByText('0/1 in use')).toBeInTheDocument();
    expect(screen.getByText(/no computer is signed in yet/i)).toBeInTheDocument();
  });
});
