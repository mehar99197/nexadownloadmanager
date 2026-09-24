/**
 * "Download my data" has to save the export itself.
 *
 * /user/export answers with the file bare (AUDIT.md L-03), not inside the
 * {ok, data} envelope. The page kept unwrapping it, found no `data`, and saved
 * the word "undefined" while toasting success.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

const user = {
  id: 7, name: 'Customer', email: 'customer@example.test', role: 'user',
  createdAt: '2026-01-01T00:00:00.000Z', hasPassword: true,
};

vi.mock('../api/client', () => {
  const api = { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() };
  return {
    default: api,
    unwrap: (res) => res?.data?.data,
    setAccessToken: vi.fn(),
    SESSION_ENDED_EVENT: 'ndm:session-ended',
  };
});
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user, loading: false, isAuthenticated: true, logout: vi.fn(), refreshMe: vi.fn() }),
  AuthProvider: ({ children }) => children,
}));
import api from '../api/client';

import { ToastProvider } from '../components/Toast';
import Profile from '../pages/Profile';

const EXPORT = {
  exportedAt: '2026-09-24T00:00:00.000Z',
  user: { id: 7, name: 'Customer', email: 'customer@example.test' },
  subscriptions: [], payments: [], review: null, team: null,
};

let saved;          // the Blob handed to the download link
let savedName;
const realCreate = URL.createObjectURL;
const realRevoke = URL.revokeObjectURL;
const realClick = window.HTMLAnchorElement.prototype.click;

beforeEach(() => {
  vi.clearAllMocks();
  saved = undefined;
  savedName = undefined;
  URL.createObjectURL = vi.fn((blob) => { saved = blob; return 'blob:export'; });
  URL.revokeObjectURL = vi.fn();
  window.HTMLAnchorElement.prototype.click = function click() { savedName = this.download; };
  api.get.mockResolvedValue({ data: { ok: true, data: {} } });
});

afterEach(() => {
  URL.createObjectURL = realCreate;
  URL.revokeObjectURL = realRevoke;
  window.HTMLAnchorElement.prototype.click = realClick;
});

const text = (blob) => (blob.text ? blob.text() : new window.Response(blob).text());

async function download(answer) {
  api.get.mockImplementation(async (url) => (url === '/user/export' ? answer : { data: { ok: true, data: {} } }));
  render(<MemoryRouter><ToastProvider><Profile /></ToastProvider></MemoryRouter>);
  await userEvent.click(await screen.findByRole('button', { name: /download my data/i }));
}

describe('Profile: Download my data', () => {
  it('saves the export the server sent, bare, as the file', async () => {
    await download({ data: EXPORT });

    await waitFor(() => expect(saved).toBeDefined());
    const body = await text(saved);
    expect(body).not.toBe('undefined');
    expect(JSON.parse(body)).toEqual(EXPORT);
    expect(savedName).toBe('nexa-account-7.json');
    expect(await screen.findByText('Your data was downloaded as JSON.')).toBeInTheDocument();
  });

  it('still reads an export wrapped in the envelope (a server older than L-03)', async () => {
    await download({ data: { ok: true, data: EXPORT } });

    await waitFor(() => expect(saved).toBeDefined());
    expect(JSON.parse(await text(saved))).toEqual(EXPORT);
  });

  it('an empty answer is an error, not an empty file under a success toast', async () => {
    await download({ data: '' });

    expect(await screen.findByText('Could not export your data.')).toBeInTheDocument();
    expect(saved).toBeUndefined();
    expect(screen.queryByText('Your data was downloaded as JSON.')).not.toBeInTheDocument();
  });
});
