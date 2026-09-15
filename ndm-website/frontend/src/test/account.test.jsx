import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { ToastProvider } from '../components/Toast';
import TwoFactorCard from '../components/account/TwoFactorCard';
import SessionsCard, { describeUserAgent } from '../components/account/SessionsCard';

vi.mock('../api/client', () => {
  const api = { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() };
  return { default: api, unwrap: (res) => res?.data?.data };
});
import api from '../api/client';

// jsdom has no canvas, which is what the browser build of `qrcode` draws on.
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async () => 'data:image/png;base64,QR') } }));

const envelope = (data) => Promise.resolve({ data: { ok: true, data } });
const renderCard = (ui) => render(<MemoryRouter><ToastProvider>{ui}</ToastProvider></MemoryRouter>);

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
  api.delete.mockReset();
});

describe('TwoFactorCard — enrolment', () => {
  it('walks from Off through the QR code to the recovery codes', async () => {
    api.get.mockImplementation((path) => {
      if (path === '/auth/2fa') return envelope({ enabled: false, pending: false, recoveryCodesLeft: 0 });
      return envelope({});
    });
    api.post.mockImplementation((path) => {
      if (path === '/auth/2fa/setup')
        return envelope({ secret: 'JBSWY3DPEHPK3PXP', otpauthUrl: 'otpauth://totp/Nexa:me?secret=JBSWY3DPEHPK3PXP' });
      if (path === '/auth/2fa/enable')
        return envelope({ enabled: true, recoveryCodes: ['aaaaa-11111', 'bbbbb-22222'] });
      return envelope({});
    });

    renderCard(<TwoFactorCard user={{ hasPassword: true }} />);

    expect(await screen.findByTestId('two-factor-status')).toHaveTextContent('Off');
    await userEvent.click(screen.getByRole('button', { name: /turn on/i }));

    // The secret is shown as text beside the QR code for people who cannot scan.
    expect(await screen.findByTestId('totp-secret')).toHaveTextContent('JBSWY3DPEHPK3PXP');
    expect(screen.getByAltText(/QR code/i)).toHaveAttribute('src', 'data:image/png;base64,QR');

    // Now the status the server reports flips to on.
    api.get.mockImplementation((path) => {
      if (path === '/auth/2fa') return envelope({ enabled: true, pending: false, recoveryCodesLeft: 2 });
      return envelope({});
    });
    await userEvent.type(screen.getByLabelText(/code from the app/i), '123456');
    await userEvent.click(screen.getByRole('button', { name: /verify and turn on/i }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/auth/2fa/enable', { code: '123456' }));
    const codes = await screen.findByTestId('recovery-codes');
    expect(within(codes).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['aaaaa-11111', 'bbbbb-22222']);
    await waitFor(() => expect(screen.getByTestId('two-factor-status')).toHaveTextContent('On'));
  });

  it('does not ask a Google-created account for a password it does not have', async () => {
    api.get.mockImplementation(() => envelope({ enabled: true, pending: false, recoveryCodesLeft: 8 }));
    api.post.mockImplementation(() => envelope({ enabled: false }));

    renderCard(<TwoFactorCard user={{ hasPassword: false }} />);

    await userEvent.click(await screen.findByRole('button', { name: /turn off…/i }));
    expect(screen.queryByLabelText(/^password$/i)).toBeNull();
    await userEvent.type(screen.getByLabelText(/code from the app/i), '654321');
    await userEvent.click(screen.getByRole('button', { name: /turn off two-factor/i }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/auth/2fa/disable', { code: '654321' }));
  });
});

describe('SessionsCard', () => {
  it('marks this browser, and signs out another one by id', async () => {
    const sessions = [
      { id: 7, current: true, userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/128.0 Safari/537.36', ip: '203.0.113.5', lastUsedAt: new Date().toISOString() },
      { id: 9, current: false, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Version/17.0 Mobile Safari/604.1', ip: '198.51.100.9', lastUsedAt: new Date(Date.now() - 3 * 3600e3).toISOString() },
    ];
    api.get.mockImplementation((path) => (path === '/user/sessions' ? envelope({ sessions }) : envelope({})));
    api.delete.mockResolvedValue({ data: { ok: true, data: { revoked: true } } });

    renderCard(<SessionsCard />);

    const list = await screen.findByTestId('session-list');
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Chrome on Windows');
    expect(rows[0]).toHaveTextContent('This browser');
    expect(within(rows[0]).queryByRole('button', { name: /sign out/i })).toBeNull();
    expect(rows[1]).toHaveTextContent('Safari on iPhone');
    expect(rows[1]).toHaveTextContent('3 h ago');

    await userEvent.click(within(rows[1]).getByRole('button', { name: /sign out/i }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/user/sessions/9'));
  });

  it('describes user agents coarsely but recognisably', () => {
    expect(describeUserAgent('Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/129.0')).toBe('Firefox on Linux');
    expect(describeUserAgent('Mozilla/5.0 (Windows NT 10.0) Chrome/128.0 Safari/537.36 Edg/128.0')).toBe('Edge on Windows');
    expect(describeUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Version/17.0 Safari/605.1.15')).toBe('Safari on macOS');
    expect(describeUserAgent('')).toBe('Unknown browser');
  });
});
