/**
 * The header for a signed-in account.
 *
 * "Logout" used to be a full-size button beside Dashboard on every page, one
 * mis-click from ending the session. It lives in the account menu now, which
 * has to open, close on Escape and hand focus back like any disclosure.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import Navbar from '../components/Navbar';

const authState = {
  isAuthenticated: true,
  user: { name: 'Owner', email: 'owner@example.test' },
  logout: vi.fn(async () => {}),
};
vi.mock('../context/AuthContext', () => ({
  useAuth: () => authState,
  AuthProvider: ({ children }) => children,
}));

describe('Navbar — a signed-in account', () => {
  it('keeps signing out inside the account menu', async () => {
    render(<MemoryRouter><Navbar /></MemoryRouter>);

    expect(screen.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('href', '/dashboard');
    expect(screen.queryByRole('button', { name: /log ?out/i })).toBeNull();

    const account = screen.getByRole('button', { name: /account/i });
    expect(account).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(account);
    expect(account).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('owner@example.test')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Billing' })).toHaveAttribute('href', '/billing');
    expect(screen.getByRole('link', { name: 'Profile' })).toHaveAttribute('href', '/profile');

    await userEvent.keyboard('{Escape}');
    expect(account).toHaveAttribute('aria-expanded', 'false');
    expect(account).toHaveFocus();
    expect(screen.queryByRole('link', { name: 'Billing' })).toBeNull();
  });

  it('signs out from the menu', async () => {
    render(<MemoryRouter><Navbar /></MemoryRouter>);
    await userEvent.click(screen.getByRole('button', { name: /account/i }));
    await userEvent.click(screen.getByRole('button', { name: /log out/i }));
    expect(authState.logout).toHaveBeenCalled();
  });
});
