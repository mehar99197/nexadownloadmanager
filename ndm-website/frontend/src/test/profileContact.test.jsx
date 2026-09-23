/**
 * T-07, finishing the pages that do something irreversible or that post.
 *
 * Profile carries account deletion — the one action on this site that cannot
 * be undone — behind a password and a typed confirmation. Contact carries the
 * honeypot, which only works if the field stays invisible and is sent anyway.
 *
 * `Security.jsx` turned out not to belong on the list it was put on: it is a
 * static page of privacy claims with no form and no API call. It is named in
 * AUDIT.md as an authentication path, and that was wrong.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

const logout = vi.fn();
const refreshMe = vi.fn();
const user = {
  id: 1, name: 'Customer', email: 'customer@example.test', role: 'user',
  createdAt: '2026-01-01T00:00:00.000Z', hasPassword: true,
};

vi.mock('../api/client', () => {
  const api = { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() };
  return { default: api, unwrap: (res) => res?.data?.data, SESSION_ENDED_EVENT: 'ndm:session-ended' };
});
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user, loading: false, isAuthenticated: true,
    logout: (...a) => logout(...a),
    refreshMe: (...a) => refreshMe(...a),
  }),
  AuthProvider: ({ children }) => children,
}));
import api from '../api/client';

import { ToastProvider } from '../components/Toast';
import Profile from '../pages/Profile';
import Contact from '../pages/Contact';

const show = (ui) => render(
  <MemoryRouter><ToastProvider>{ui}</ToastProvider></MemoryRouter>
);

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue({ data: { ok: true, data: {} } });
  api.post.mockResolvedValue({ data: { ok: true, data: {} } });
  api.delete.mockResolvedValue({ data: { ok: true, data: {} } });
});

describe('Profile — deleting an account', () => {
  it('does not delete anything until the dialog is opened and filled', async () => {
    show(<Profile />);
    // The button on the page opens a dialog; it must not be the action itself.
    const opener = await screen.findByRole('button', { name: /delete (my )?account/i });
    await userEvent.click(opener);
    expect(api.delete).not.toHaveBeenCalled();
  });

  it('sends the password and the typed confirmation together', async () => {
    show(<Profile />);
    await userEvent.click(await screen.findByRole('button', { name: /delete (my )?account/i }));

    await userEvent.type(await screen.findByLabelText('Password'), 'my-password');
    await userEvent.type(screen.getByLabelText(/type delete to confirm/i), 'DELETE');

    const buttons = screen.getAllByRole('button', { name: /delete/i });
    await userEvent.click(buttons[buttons.length - 1]);

    await waitFor(() => expect(api.delete).toHaveBeenCalledWith(
      '/user/account',
      { data: { password: 'my-password', confirm: 'DELETE' } }
    ));
    // Deleting the account ends the session; leaving a dead bearer in the tab
    // would be the difference between "gone" and "looks gone".
    await waitFor(() => expect(logout).toHaveBeenCalled());
  });

  it('keeps the user on the page when the server refuses', async () => {
    api.delete.mockRejectedValue(Object.assign(new Error('Password is incorrect'), {
      response: { data: { ok: false, error: { code: 'INVALID_PASSWORD', message: 'Password is incorrect' } } },
    }));
    show(<Profile />);
    await userEvent.click(await screen.findByRole('button', { name: /delete (my )?account/i }));
    await userEvent.type(await screen.findByLabelText('Password'), 'wrong');
    await userEvent.type(screen.getByLabelText(/type delete to confirm/i), 'DELETE');
    const buttons = screen.getAllByRole('button', { name: /delete/i });
    await userEvent.click(buttons[buttons.length - 1]);

    expect(await screen.findByText(/password is incorrect/i)).toBeInTheDocument();
    expect(logout).not.toHaveBeenCalled();
  });
});

describe('Contact — the honeypot', () => {
  it('keeps the trap out of sight and out of the tab order', async () => {
    show(<Contact />);
    // A honeypot a human can see or tab into catches humans, which is worse
    // than catching nothing.
    //
    // Asserted structurally rather than with toBeVisible(): the field is
    // hidden by Tailwind's .hidden class, and this suite runs with css:false,
    // so jsdom computes it as visible. A visibility assertion here would be
    // testing the absence of a stylesheet, not the markup.
    const website = document.querySelector('input[name="website"]');
    expect(website).not.toBeNull();
    expect(website.getAttribute('tabindex')).toBe('-1');
    expect(website.getAttribute('autocomplete')).toBe('off');
    const label = website.closest("label");
    expect(label.getAttribute('aria-hidden')).toBe('true');
    expect(label.className).toContain('hidden');
  });

  it('posts a real message with the trap left empty', async () => {
    show(<Contact />);
    // The page prefills name and email for a signed-in visitor, so these have
    // to be cleared before typing or the values concatenate.
    await userEvent.clear(screen.getByLabelText(/name/i));
    await userEvent.type(screen.getByLabelText(/name/i), 'A Person');
    await userEvent.clear(screen.getByLabelText(/email/i));
    await userEvent.type(screen.getByLabelText(/email/i), 'person@example.test');
    await userEvent.type(screen.getByLabelText(/message/i), 'This is a long enough message to send.');
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/contact',
      expect.objectContaining({ email: 'person@example.test', website: '' })
    ));
  });

  it('shows the server’s refusal without naming the trap', async () => {
    // L-02: the 400 for a tripped honeypot must not point at the field, or it
    // tells the next bot exactly which one to leave alone.
    api.post.mockRejectedValue(Object.assign(new Error('This message could not be accepted.'), {
      response: {
        data: {
          ok: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'This message could not be accepted.',
            details: { formErrors: ['This message could not be accepted.'], fieldErrors: {} },
          },
        },
      },
    }));

    show(<Contact />);
    await userEvent.type(screen.getByLabelText(/message/i), 'This is a long enough message to send.');
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }));

    const shown = await screen.findByText(/could not be accepted/i);
    expect(shown).toBeInTheDocument();
    // The refusal must not name the field. Scoped to the message itself: the
    // hidden label literally reads "Website", so a page-wide search for the
    // word would fail on the trap it is checking.
    expect(shown.textContent).not.toMatch(/website/i);
  });
});
