/**
 * The sidebar folds to a rail of icons on a desktop, and opens the way it was
 * left.
 *
 * jsdom has no box model, so the widths, the icons holding still and where a
 * tip lands are advanced.spec.js's to measure. This is the state: the toggle,
 * the names every link keeps, the memory, and when a tip shows and goes.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../context/AdminAuthContext.jsx', () => ({
  useAdminAuth: () => ({ logout: vi.fn(), admin: { name: 'Staff' } }),
}));

const { default: AdminLayout } = await import('../components/AdminLayout.jsx');
const { default: PanelSkeleton } = await import('../components/PanelSkeleton.jsx');

const KEY = 'nexa-admin-sidebar';
const NAMES = ['Dashboard', 'Users', 'Subscriptions', 'Reviews', 'Contact inbox', 'Releases', 'Ads', 'Activity log', 'Security'];

function renderPanel() {
  return render(
    <MemoryRouter initialEntries={['/users']}>
      <Routes>
        <Route element={<AdminLayout />}>
          <Route path="/users" element={<div>USERS SCREEN</div>} />
          <Route path="/reviews" element={<div>REVIEWS SCREEN</div>} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

const toggle = () => screen.getByRole('button', { name: 'Collapse sidebar' });
const tipText = () => document.querySelector('.rail-tip')?.textContent ?? null;
const link = (name) => screen.getByRole('link', { name });

// setup.js answers "no" to every media query; a tip is for a desktop.
function onADesktop() {
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
    matches: true,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  }));
}

describe('folding the sidebar', () => {
  it('folds to a rail and back, and every link keeps its name', async () => {
    const user = userEvent.setup();
    renderPanel();
    expect(toggle()).toHaveAttribute('aria-pressed', 'false');
    expect(toggle()).toHaveAttribute('aria-controls', 'admin-sidebar');

    await user.click(toggle());
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');
    expect(localStorage.getItem(KEY)).toBe('rail');
    // The labels are hidden from sight, not removed: each name is exactly
    // the label, with the icon beside it kept out of it.
    for (const name of NAMES) expect(link(name)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Logout' })).toBeInTheDocument();

    await user.click(toggle());
    expect(toggle()).toHaveAttribute('aria-pressed', 'false');
    expect(localStorage.getItem(KEY)).toBe('open');
  });

  it('opens folded when it was left folded', () => {
    localStorage.setItem(KEY, 'rail');
    renderPanel();
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');
  });

  it('draws the boot outline at the width it was left, so the panel does not arrive and fold', () => {
    const { unmount } = render(<PanelSkeleton />);
    const open = document.querySelectorAll('aside .skeleton').length;
    unmount();

    localStorage.setItem(KEY, 'rail');
    render(<PanelSkeleton />);
    const folded = document.querySelectorAll('aside .skeleton').length;

    // Open: the logo, two lines of brand, and a mark and a label per link.
    expect(open).toBe(3 + NAMES.length * 2);
    // Folded: the logo and one mark per link.
    expect(folded).toBe(1 + NAMES.length);
  });

  it('folds with Ctrl+B on a desktop, but not while typing', async () => {
    onADesktop();
    const user = userEvent.setup();
    renderPanel();
    await user.keyboard('{Control>}b{/Control}');
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');
    await user.keyboard('{Meta>}b{/Meta}');
    expect(toggle()).toHaveAttribute('aria-pressed', 'false');

    const field = document.createElement('input');
    document.body.appendChild(field);
    field.focus();
    await user.keyboard('{Control>}b{/Control}');
    expect(toggle()).toHaveAttribute('aria-pressed', 'false');
    field.remove();
  });

  it('still folds when storage refuses, for the visit', async () => {
    vi.spyOn(window.Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(window.Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const user = userEvent.setup();
    renderPanel();
    expect(toggle()).toHaveAttribute('aria-pressed', 'false');
    await user.click(toggle());
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('the rail names its icons', () => {
  it('for a pointer resting on one, and Escape puts the name away', async () => {
    localStorage.setItem(KEY, 'rail');
    onADesktop();
    const user = userEvent.setup();
    renderPanel();

    await user.hover(link('Reviews'));
    expect(tipText()).toBe('Reviews');
    expect(document.querySelector('.rail-tip')).toHaveAttribute('aria-hidden', 'true');

    await user.keyboard('{Escape}');
    expect(tipText()).toBeNull();
  });

  it('stays while the pointer moves onto the name, and goes when it leaves', async () => {
    localStorage.setItem(KEY, 'rail');
    onADesktop();
    const user = userEvent.setup();
    renderPanel();

    await user.hover(link('Reviews'));
    await user.hover(document.querySelector('.rail-tip'));
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(tipText()).toBe('Reviews');

    await user.unhover(document.querySelector('.rail-tip'));
    expect(tipText()).toBeNull();
  });

  it('for keyboard focus, link by link', async () => {
    localStorage.setItem(KEY, 'rail');
    onADesktop();
    // A browser matches :focus-visible on every element the Tab key reaches;
    // jsdom does on the first only. Give it the browser's answer — the e2e
    // spec checks the real one.
    const matches = window.Element.prototype.matches;
    vi.spyOn(window.Element.prototype, 'matches').mockImplementation(function focusVisibleLikeABrowser(selector) {
      return selector === ':focus-visible' ? this === document.activeElement : matches.call(this, selector);
    });
    const user = userEvent.setup();
    renderPanel();

    // The fold comes first: it sits in the brand row, above the links.
    await user.tab();
    expect(toggle()).toHaveFocus();
    expect(tipText()).toBe('Expand sidebar · Ctrl+B');
    await user.tab();
    expect(link('Dashboard')).toHaveFocus();
    expect(tipText()).toBe('Dashboard');
    await user.tab();
    expect(tipText()).toBe('Users');
  });

  it('goes when its link is followed', async () => {
    localStorage.setItem(KEY, 'rail');
    onADesktop();
    const user = userEvent.setup();
    renderPanel();

    await user.hover(link('Reviews'));
    await user.click(link('Reviews'));
    expect(await screen.findByText('REVIEWS SCREEN')).toBeInTheDocument();
    expect(tipText()).toBeNull();
  });

  it('shows nothing while the sidebar is open, or on a phone, where the labels are drawn', async () => {
    onADesktop();
    const user = userEvent.setup();
    renderPanel();
    await user.hover(link('Reviews'));
    expect(tipText()).toBeNull();

    // Folded, on a phone: the drawer carries its labels.
    window.matchMedia.mockRestore();
    await user.click(toggle());
    await user.hover(link('Users'));
    expect(tipText()).toBeNull();
  });
});
