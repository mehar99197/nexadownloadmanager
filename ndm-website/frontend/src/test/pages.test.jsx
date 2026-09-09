import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import ErrorBoundary from '../components/ErrorBoundary';
import { AuthProvider } from '../context/AuthContext';
import { ToastProvider } from '../components/Toast';
import Home from '../pages/Home';
import Download from '../pages/Download';
import Compare from '../pages/Compare';
import Input from '../components/Input';
import Spinner from '../components/Spinner';

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

  // The page pre-selects a platform from the user agent and turns that card's
  // button into the primary CTA reading "Download for <label>". Android's UA is
  // "Mozilla/5.0 (Linux; Android 14; ...)", so a bare includes('Linux') matched
  // every phone and offered a .deb as the recommended download.
  describe('platform pre-selection', () => {
    const withUserAgent = (ua, fn) => {
      const original = Object.getOwnPropertyDescriptor(window.navigator, 'userAgent');
      Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true });
      try { return fn(); } finally {
        if (original) Object.defineProperty(window.navigator, 'userAgent', original);
      }
    };

    const renderWith = async (ua) => {
      api.get.mockResolvedValue({
        data: { ok: true, data: { version: '0.2.0', windowsUrl: 'https://e.test/a.exe', linuxUrl: 'https://e.test/a.deb' } },
      });
      withUserAgent(ua, () => renderPage(<Download />));
      await waitFor(() => expect(api.get).toHaveBeenCalled());
    };

    it('recommends Windows to a Windows desktop', async () => {
      await renderWith('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36');
      await waitFor(() => expect(screen.getByText(/Download for Windows/i)).toBeTruthy());
    });

    it('recommends Linux to a Linux desktop', async () => {
      await renderWith('Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0');
      await waitFor(() => expect(screen.getByText(/Download for Linux/i)).toBeTruthy());
    });

    it('recommends nothing to an Android phone — its UA also says Linux', async () => {
      await renderWith('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36');
      await waitFor(() => expect(api.get).toHaveBeenCalled());
      expect(screen.queryByText(/Download for Linux/i)).toBeNull();
      expect(screen.queryByText(/Download for Windows/i)).toBeNull();
    });

    it('recommends nothing to an Android tablet (no "Mobile" token)', async () => {
      await renderWith('Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 Chrome/119.0.0.0 Safari/537.36');
      await waitFor(() => expect(api.get).toHaveBeenCalled());
      expect(screen.queryByText(/Download for Linux/i)).toBeNull();
    });

    it('recommends nothing to macOS, which has no build yet', async () => {
      await renderWith('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/17.0 Safari/605.1.15');
      await waitFor(() => expect(api.get).toHaveBeenCalled());
      expect(screen.queryByText(/Download for /i)).toBeNull();
    });
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

describe('Compare — the feature matrix is a real table', () => {
  it('associates every cell with a product and a feature', () => {
    renderPage(<Compare />);

    // Without these a screen reader reads 80 loose "Yes"/"—" cells with nothing
    // saying which product or which row they belong to.
    const table = screen.getByRole('table', {
      name: /Feature comparison of Nexa Download Manager/i,
    });
    const colHeaders = screen.getAllByRole('columnheader');
    expect(colHeaders.map((h) => h.getAttribute('scope'))).toEqual(
      colHeaders.map(() => 'col')
    );
    expect(colHeaders.map((h) => h.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('IDM')])
    );

    const rowHeaders = screen.getAllByRole('rowheader');
    expect(rowHeaders.length).toBeGreaterThan(10);
    expect(rowHeaders.every((h) => h.getAttribute('scope') === 'row')).toBe(true);
    expect(table.querySelector('caption')).not.toBeNull();
  });

  it('announces an absent feature as "No", not as an em dash', () => {
    renderPage(<Compare />);

    // aria-label on a role-less <span> is dropped by browsers, so the previous
    // markup announced these cells as "—" or as nothing at all.
    const linux = screen.getByRole('rowheader', { name: 'Linux' }).closest('tr');
    expect(linux.textContent).toContain('No');
    expect(linux.querySelector('[aria-label]')).toBeNull();
  });
});

describe('Input — a rejected field says so', () => {
  it('marks the field invalid and points at the message', () => {
    render(<Input label="Email" name="email" error="That address is not valid." />);

    const field = screen.getByLabelText('Email');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    // The red ring alone is not an announcement: the message has to be the
    // field's description or a screen reader never reads it.
    const describedBy = field.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy)).toHaveTextContent(
      'That address is not valid.'
    );
  });

  it('describes the field by its hint when there is no error', () => {
    render(<Input label="Password" name="password" hint="At least 8 characters" />);

    const field = screen.getByLabelText('Password');
    expect(field).not.toHaveAttribute('aria-invalid');
    const describedBy = field.getAttribute('aria-describedby');
    expect(document.getElementById(describedBy)).toHaveTextContent('At least 8 characters');
  });
});

describe('Spinner — two of them on one page stay two of them', () => {
  it('gives every instance its own gradient, and points each arc at its own', () => {
    const { container } = render(
      <>
        <Spinner />
        <Spinner size={32} />
      </>
    );

    const gradients = [...container.querySelectorAll('linearGradient')];
    expect(gradients).toHaveLength(2);

    // The failure this guards against is silent: duplicate ids are legal
    // enough to render, but url(#id) resolves to whichever element came
    // first in the document, so the second spinner would quietly borrow the
    // first one's gradient — and lose it entirely if the first unmounts.
    const ids = gradients.map((node) => node.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => id && !id.includes(':'))).toBe(true);

    const arcs = [...container.querySelectorAll('.ndm-spinner__arc')];
    expect(arcs).toHaveLength(2);
    arcs.forEach((arc, i) => {
      expect(arc.getAttribute('stroke')).toBe(`url(#${ids[i]})`);
    });
  });

  it('is announced as a status, and honours the size it was given', () => {
    render(<Spinner size={32} />);
    const mark = screen.getByRole('status', { name: 'Loading' });
    expect(mark).toHaveAttribute('width', '32');
    expect(mark).toHaveAttribute('height', '32');
  });
});
