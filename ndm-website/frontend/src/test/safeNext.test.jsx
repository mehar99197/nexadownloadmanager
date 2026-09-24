/**
 * ?next= after signing in: a path on this site, and nothing else.
 *
 * Login and Register accepted any value that started with one slash and not
 * two. The browser does not read a URL by its first characters. It turns "\"
 * into "/" and drops tabs and newlines, so "/\evil.example" and
 * "/<tab>/evil.example" are protocol-relative links to another site.
 * react-router passes the value to history.replaceState, which throws on
 * another origin, so today the sign-in breaks instead of landing. Any future
 * use of push, which falls back to location.assign, would make it an open
 * redirect. The value is now resolved the way the browser resolves it, and
 * kept only when it stays on this origin.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

import safeNext from '../utils/safeNext';

vi.mock('../api/client', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  unwrap: (res) => res?.data?.data,
  SESSION_ENDED_EVENT: 'ndm:session-ended',
}));
vi.mock('../context/AuthContext', () => ({
  // Already signed in: Login forwards to `next` on its first render.
  useAuth: () => ({ isAuthenticated: true, login: vi.fn(), completeTwoFactor: vi.fn(), loginWithGoogle: vi.fn() }),
  AuthProvider: ({ children }) => children,
}));
import { ToastProvider } from '../components/Toast';
import Login from '../pages/Login';

describe('safeNext', () => {
  it.each([
    ['/dashboard', '/dashboard'],
    ['/team/join?token=abc', '/team/join?token=abc'],
    ['/docs/license#seats', '/docs/license#seats'],
    ['/billing?session=done#top', '/billing?session=done#top'],
  ])('keeps the path on this site: %s', (raw, expected) => {
    expect(safeNext(raw)).toBe(expected);
  });

  it.each([
    ['/\\evil.example', 'a backslash the parser reads as a slash'],
    ['/\t/evil.example', 'a tab the parser drops'],
    ['/\n/evil.example', 'a newline the parser drops'],
    ['//evil.example', 'a protocol-relative link'],
    ['https://evil.example/', 'an absolute link'],
    ['javascript:alert(1)', 'a script URL'],
    ['dashboard', 'a relative path'],
    ['', 'nothing'],
    [null, 'no parameter at all'],
  ])('falls back for %j (%s)', (raw) => {
    expect(safeNext(raw)).toBe('/dashboard');
  });

  it('uses the fallback it is given', () => {
    expect(safeNext('//evil.example', '/')).toBe('/');
  });
});

function Where() {
  const { pathname, search } = useLocation();
  return <p data-testid="landed">{pathname + search}</p>;
}

const signInWith = (next) => render(
  <MemoryRouter initialEntries={[`/login?next=${encodeURIComponent(next)}`]}>
    <ToastProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </ToastProvider>
  </MemoryRouter>,
);

describe('Login — where a signed-in visitor lands', () => {
  it('follows a same-site next, query included', () => {
    signInWith('/team/join?token=abc');
    expect(screen.getByTestId('landed')).toHaveTextContent('/team/join?token=abc');
  });

  it('refuses a next that the browser would read as another site', () => {
    signInWith('/\\evil.example');
    expect(screen.getByTestId('landed')).toHaveTextContent(/^\/dashboard$/);
  });
});
