import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import ErrorBoundary from '../components/ErrorBoundary';
import { AuthProvider } from '../context/AuthContext';
import { ToastProvider } from '../components/Toast';
import Home from '../pages/Home';
import Download from '../pages/Download';

// The API client is the only thing these pages touch that we do not own.
vi.mock('../api/client', () => {
  const api = { get: vi.fn(), post: vi.fn(), put: vi.fn() };
  return {
    default: api,
    unwrap: (res) => res?.data?.data,
  };
});
import api from '../api/client';

const renderPage = (ui) => render(<MemoryRouter>{ui}</MemoryRouter>);

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
});

describe('Home — honest statistics', () => {
  it('shows real numbers from the API, not invented ones', async () => {
    api.get.mockImplementation((path) => {
      if (path === '/stats') return Promise.resolve({ data: { ok: true, data: { users: 3, downloads: 17 } } });
      if (path === '/releases/latest')
        return Promise.resolve({ data: { ok: true, data: { version: '0.2.0' } } });
      return Promise.resolve({ data: { ok: true, data: {} } });
    });

    renderPage(<Home />);

    await waitFor(() => expect(screen.getByText('17')).toBeInTheDocument());
    expect(screen.getByText('3')).toBeInTheDocument();

    // The invented figures from the old build must never come back.
    for (const fake of [/50K\+/i, /10x faster/i, /99\.9%/, /1,000\+ supported sites/i]) {
      expect(screen.queryByText(fake)).toBeNull();
    }
  });

  it('hides the numeric tiles rather than inventing them when the API fails', async () => {
    api.get.mockRejectedValue(new Error('network down'));

    renderPage(<Home />);

    // Nothing that looks like a fabricated headline number should appear.
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(screen.queryByText(/50K\+/i)).toBeNull();
    expect(screen.queryByText(/downloads served/i)).toBeNull();
  });
});

describe('Download page', () => {
  it('links to the counting redirect and shows the published checksum', async () => {
    api.get.mockResolvedValue({
      data: {
        ok: true,
        data: {
          version: '0.2.0',
          windowsUrl: 'https://cdn.example.test/nexa.exe',
          linuxUrl: 'https://cdn.example.test/nexa.deb',
          windowsSha256: 'a'.repeat(64),
          linuxSha256: null,
          changelog: 'Faster everything',
        },
      },
    });

    renderPage(<Download />);

    // The version appears in several places once the release loads.
    await waitFor(() => expect(screen.getAllByText(/0\.2\.0/).length).toBeGreaterThan(0));

    // Downloads must go through /releases/download/<os> so they are counted.
    const links = Array.from(document.querySelectorAll('a[href]')).map((a) => a.getAttribute('href'));
    expect(links.some((h) => h && h.includes('/releases/download/windows'))).toBe(true);
    expect(links.some((h) => h && h.includes('/releases/download/linux'))).toBe(true);

    // The checksum we have is shown; the one we do not have is not faked.
    expect(screen.getAllByText(new RegExp('a'.repeat(16))).length).toBe(1);
  });

  it('says the version is unpublished instead of showing a stale fallback', async () => {
    api.get.mockRejectedValue({ response: { status: 404 } });

    renderPage(<Download />);

    await waitFor(() => expect(api.get).toHaveBeenCalled());
    // The old hard-coded "v0.1.0" fallback must be gone.
    expect(screen.queryByText(/v?0\.1\.0/)).toBeNull();
  });
});

describe('ErrorBoundary', () => {
  it('shows a recovery message instead of a blank page when a child throws', () => {
    const Boom = () => {
      throw new Error('kaboom');
    };
    // React logs the error; keep the test output readable.
    vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <MemoryRouter>
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>
      </MemoryRouter>
    );

    expect(document.body.textContent).not.toBe('');
    expect(screen.getByRole('heading', { name: /something went wrong/i })).toBeInTheDocument();
  });
});

describe('usePageMeta', () => {
  it('sets a distinct document title per page', async () => {
    api.get.mockResolvedValue({ data: { ok: true, data: {} } });
    renderPage(<Download />);
    await waitFor(() => expect(document.title).toMatch(/Nexa Download Manager/));
    expect(document.title).toMatch(/Download/);
  });
});

describe('trial helper', () => {
  it('reports days left without ever going negative', async () => {
    const { trialDaysLeft } = await import('../api/trial');
    const inThreeDays = new Date(Date.now() + 3 * 86400000).toISOString();
    expect(trialDaysLeft(inThreeDays)).toBeGreaterThan(0);
    expect(trialDaysLeft(inThreeDays)).toBeLessThanOrEqual(3);

    const past = new Date(Date.now() - 86400000).toISOString();
    expect(trialDaysLeft(past)).toBe(0);
    expect(trialDaysLeft(null)).toBe(0);
    expect(trialDaysLeft('not a date')).toBe(0);
  });
});

describe('Pricing promotion code', () => {
  it('reports an invalid code instead of silently charging full price', async () => {
    const Pricing = (await import('../pages/Pricing')).default;
    api.get.mockResolvedValue({
      data: { ok: true, data: { free: { id: 'free', name: 'Free', price: 0, features: [] },
                                pro: { id: 'pro', name: 'Pro', monthly: 5, yearly: 45, features: [] },
                                team: { id: 'team', name: 'Team', monthly: 15, yearly: 135, features: [] } } },
    });
    api.post.mockRejectedValue({
      response: { data: { error: { code: 'INVALID_COUPON', message: 'That code is not valid' } } },
    });

    render(
      <MemoryRouter>
        <ToastProvider>
          <AuthProvider>
            <Pricing />
          </AuthProvider>
        </ToastProvider>
      </MemoryRouter>
    );

    const input = await screen.findByPlaceholderText(/promotion code/i);
    await userEvent.type(input, 'NOPE');
    await userEvent.click(screen.getByRole('button', { name: /apply/i }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/not valid/i));
  });
});

describe('Billing — a cancelled renewal keeps the paid period', () => {
  const mount = async () => {
    const Billing = (await import('../pages/Billing')).default;
    const { ConfirmProvider } = await import('../components/ConfirmDialog');
    render(
      <MemoryRouter initialEntries={['/billing']}>
        <ToastProvider>
          <ConfirmProvider>
            <Billing />
          </ConfirmProvider>
        </ToastProvider>
      </MemoryRouter>
    );
  };
  const status = (extra) => ({
    data: { ok: true, data: { plan: 'pro', status: 'active', expiryDate: '2030-01-15T00:00:00.000Z',
                              seats: 1, trial: false, trialEndsAt: null, cancelAtPeriodEnd: false, ...extra } },
  });

  it('offers cancellation while the renewal is on', async () => {
    api.get.mockImplementation((url) => Promise.resolve(
      url === '/user/billing' ? { data: { ok: true, data: { payments: [] } } } : status()
    ));
    await mount();
    expect(await screen.findByRole('button', { name: /cancel subscription/i })).toBeInTheDocument();
    expect(screen.getByText(/^expires$/i)).toBeInTheDocument();
  });

  it('after cancelling it says when access ends and hides the button', async () => {
    api.get.mockImplementation((url) => Promise.resolve(
      url === '/user/billing' ? { data: { ok: true, data: { payments: [] } } } : status({ cancelAtPeriodEnd: true })
    ));
    await mount();
    expect(await screen.findByText(/ends on/i)).toBeInTheDocument();
    expect(screen.getByText(/renewal is switched off/i)).toBeInTheDocument();
    expect(screen.getByText(/^active$/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /cancel subscription/i })).not.toBeInTheDocument();
  });
});
