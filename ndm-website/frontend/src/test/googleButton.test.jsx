import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { useEffect } from 'react';

const SCRIPT_SEL = 'script[src="https://accounts.google.com/gsi/client"]';
const NONCE = 'test-nonce.1700000000000.abcdefghijklmnopqrstuv';

// The button asks the API for an OIDC nonce before it initialises Google;
// jsdom has no server, so the client is stubbed to hand one out.
vi.mock('../api/client', () => ({
  default: { get: vi.fn(async () => ({ data: { ok: true, data: { nonce: NONCE } } })) },
  unwrap: (res) => res.data.data,
}));

// CLIENT_ID is read once at module evaluation, so each case stubs the env and
// re-imports the component instead of relying on a developer's local .env.
async function loadWith(clientId = 'test-client-id.apps.googleusercontent.com') {
  vi.resetModules();
  vi.stubEnv('VITE_GOOGLE_CLIENT_ID', clientId);
  return (await import('../components/GoogleButton')).default;
}

/** Stand in for the GIS API so loadScript resolves without a network fetch. */
function stubGis() {
  const id = { initialize: vi.fn(), renderButton: vi.fn() };
  window.google = { accounts: { id } };
  return id;
}

/** jsdom does no layout, so clientWidth is always 0 — fake the card's width. */
function stubWidth(px) {
  Object.defineProperty(HTMLDivElement.prototype, 'clientWidth', {
    configurable: true,
    get() { return px; },
  });
}

const lastRenderOpts = (gis) => gis.renderButton.mock.calls.at(-1)[1];

beforeEach(() => {
  document.documentElement.removeAttribute('data-theme');
  document.querySelectorAll(SCRIPT_SEL).forEach((s) => s.remove());
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete window.google;
  delete HTMLDivElement.prototype.clientWidth;
});

describe('GoogleButton — the white slab', () => {
  it('pins the iframe wrapper to the light colour scheme so browsers keep it transparent', async () => {
    // The site sets color-scheme: dark on <html>; Google's iframe is a light
    // document. A mismatch makes the browser paint an opaque white canvas behind
    // the iframe — the white slab around the pill on the auth cards.
    const GoogleButton = await loadWith();
    render(<GoogleButton onCredential={() => {}} />);
    expect(screen.getByTestId('google-button')).toHaveClass('scheme-light');
  });
});

describe('GoogleButton — the nonce', () => {
  it('initialises Google with the nonce the server issued and hands it back with the credential', async () => {
    // The backend accepts only an ID token carrying the nonce it gave THIS
    // browser (GET /api/auth/google/nonce), so the value has to reach
    // initialize() and travel back to the caller beside the credential.
    stubWidth(320);
    const gis = stubGis();
    const GoogleButton = await loadWith();
    const onCredential = vi.fn();
    await act(async () => { render(<GoogleButton onCredential={onCredential} />); });
    const init = gis.initialize.mock.calls.at(-1)[0];
    expect(init.nonce).toBe(NONCE);
    init.callback({ credential: 'id-token' });
    expect(onCredential).toHaveBeenCalledWith('id-token', NONCE);
  });
});

describe('GoogleButton — fitting the card', () => {
  it('asks Google for the width the card can actually give it, not a fixed 320', async () => {
    // `width` is a MINIMUM to GIS, so on a phone (214px of content box at a
    // 320px viewport) a hard-coded 320 overflows and .card{overflow:hidden}
    // clips the pill's rounded ends.
    stubWidth(214);
    const gis = stubGis();
    const GoogleButton = await loadWith();
    await act(async () => { render(<GoogleButton onCredential={() => {}} />); });
    expect(lastRenderOpts(gis).width).toBe(214);
  });

  it('still caps at 320 on a wide card', async () => {
    stubWidth(900);
    const gis = stubGis();
    const GoogleButton = await loadWith();
    await act(async () => { render(<GoogleButton onCredential={() => {}} />); });
    expect(lastRenderOpts(gis).width).toBe(320);
  });

  it('reserves the pill height so the form does not jump when the script lands', async () => {
    const GoogleButton = await loadWith();
    render(<GoogleButton onCredential={() => {}} />);
    expect(screen.getByTestId('google-button')).toHaveClass('min-h-10');
  });
});

describe('GoogleButton — blocking a second submit', () => {
  it('makes the button inert while a request is in flight, not just pointer-blocked', async () => {
    // pointer-events-none leaves Google's role="button" reachable by Tab, so
    // Enter could start a second flow. inert is what actually stops it.
    const GoogleButton = await loadWith();
    render(<GoogleButton onCredential={() => {}} disabled />);
    const wrapper = screen.getByTestId('google-button');
    expect(wrapper).toHaveAttribute('inert');
    expect(wrapper).toHaveAttribute('aria-busy', 'true');
    expect(wrapper).toHaveClass('pointer-events-none');
  });

  it('leaves the button reachable when idle', async () => {
    const GoogleButton = await loadWith();
    render(<GoogleButton onCredential={() => {}} />);
    const wrapper = screen.getByTestId('google-button');
    expect(wrapper).not.toHaveAttribute('inert');
    expect(wrapper).not.toHaveAttribute('aria-busy');
  });
});

describe('GoogleButton — when Google does not load', () => {
  it('reports failure instead of leaving a silent gap when the API is stubbed away', async () => {
    // A privacy extension can let the script "load" while removing the API.
    window.google = { accounts: {} };
    const GoogleButton = await loadWith();
    render(<GoogleButton onCredential={() => {}} />);
    await act(async () => {
      document.querySelector(SCRIPT_SEL).dispatchEvent(new Event('load'));
    });
    expect(screen.getByText(/could not load/i)).toBeInTheDocument();
    expect(screen.queryByTestId('google-button')).toBeNull();
  });

  it('uses the caller’s wording, so the sign-up card does not say "use your password"', async () => {
    const GoogleButton = await loadWith();
    render(
      <GoogleButton
        onCredential={() => {}}
        fallback="Google sign-up could not load. Create your account with the form below."
      />
    );
    await act(async () => {
      document.querySelector(SCRIPT_SEL).dispatchEvent(new Event('error'));
    });
    expect(screen.getByText(/create your account with the form below/i)).toBeInTheDocument();
  });

  it('drops the "or" divider with the button, so the card never reads "could not load — or —"', async () => {
    const GoogleButton = await loadWith();
    render(<GoogleButton onCredential={() => {}} />);
    expect(screen.getByText('or')).toBeInTheDocument();
    await act(async () => {
      document.querySelector(SCRIPT_SEL).dispatchEvent(new Event('error'));
    });
    expect(screen.queryByText('or')).toBeNull();
  });
});

describe('GoogleButton — theme', () => {
  it('picks the light pill when the theme is painted by an effect above it', async () => {
    // useTheme() runs in the Navbar, which is earlier in the tree, so it stamps
    // data-theme in an effect that runs BEFORE this component's — but after the
    // render that seeded the state. Reading only at render time (or only
    // watching for later mutations) leaves a black pill on the white card.
    const gis = stubGis();
    const GoogleButton = await loadWith();
    const Painter = () => {
      useEffect(() => { document.documentElement.setAttribute('data-theme', 'light'); }, []);
      return null;
    };
    await act(async () => {
      render(<><Painter /><GoogleButton onCredential={() => {}} /></>);
    });
    expect(lastRenderOpts(gis).theme).toBe('outline');
  });

  it('restyles the pill when the site theme is toggled on this page', async () => {
    const gis = stubGis();
    const GoogleButton = await loadWith();
    await act(async () => { render(<GoogleButton onCredential={() => {}} />); });
    expect(lastRenderOpts(gis).theme).toBe('filled_black');

    await act(async () => {
      document.documentElement.setAttribute('data-theme', 'light');
    });
    expect(lastRenderOpts(gis).theme).toBe('outline');
  });
});

describe('GoogleButton — build without a client id', () => {
  it('renders nothing at all, divider included', async () => {
    const GoogleButton = await loadWith('');
    const { container } = render(<GoogleButton onCredential={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});
