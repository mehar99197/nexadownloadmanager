/**
 * Turning on two-factor from the Security page sends the account password
 * with the code. The API refuses an enable without it, so a stolen panel
 * access token cannot enrol an authenticator nobody else holds and lock the
 * operator out; this pins the panel's half of that contract.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
const post = vi.fn();
const refreshAdmin = vi.fn();

vi.mock('../api/client.js', () => ({
  default: { get: (...a) => get(...a), post: (...a) => post(...a) },
  unwrap: async (p) => {
    const res = await p;
    if (res?.data?.ok === false) throw new Error(res.data.error?.message || 'failed');
    return res?.data?.data;
  },
}));
vi.mock('../context/AdminAuthContext.jsx', () => ({
  useAdminAuth: () => ({ admin: { email: 'staff@example.test' }, refreshAdmin, mustEnrol: true }),
}));
vi.mock('qrcode', () => ({ default: { toDataURL: async () => 'data:image/png;base64,QR' } }));

const { default: Security } = await import('../pages/Security.jsx');

const envelope = (data) => Promise.resolve({ data: { ok: true, data } });

describe('Security — enrolment', () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    refreshAdmin.mockReset();
    get.mockImplementation(() => envelope({ enabled: false, pending: false, recoveryCodesLeft: 0, recoveryCodesLegacy: false }));
    post.mockImplementation((path) => {
      if (path === '/admin/2fa/setup')
        return envelope({ secret: 'JBSWY3DPEHPK3PXP', otpauthUrl: 'otpauth://totp/Nexa:staff?secret=JBSWY3DPEHPK3PXP' });
      if (path === '/admin/2fa/enable') return envelope({ enabled: true, recoveryCodes: ['aaaaa-11111'] });
      return envelope({});
    });
  });

  it('asks for the password and sends it with the code', async () => {
    render(<Security />);
    await userEvent.click(await screen.findByRole('button', { name: /turn on/i }));
    await userEvent.type(await screen.findByPlaceholderText('123456'), '123456');

    const submit = screen.getByRole('button', { name: /verify and turn on/i });
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/^password$/i), 'admin-password-123');
    expect(submit).toBeEnabled();
    await userEvent.click(submit);

    await waitFor(() => expect(post).toHaveBeenCalledWith('/admin/2fa/enable',
      { password: 'admin-password-123', code: '123456' }));
    expect(await screen.findByTestId('recovery-codes')).toHaveTextContent('aaaaa-11111');
  });
});
