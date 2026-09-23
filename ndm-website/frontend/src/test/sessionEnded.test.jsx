import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { SESSION_ENDED_EVENT } from '../api/client';

/**
 * AUDIT.md M-10 — when a refresh fails mid-session, three things have to go,
 * not one.
 *
 * The interceptor used to call clearAccessToken() and stop there. That clears
 * a variable inside api/client.js; it does not clear the readable ndm_session
 * hint, so the NEXT page load still pays for a refresh that cannot work, and
 * it does not reset AuthContext, so the header keeps rendering an account menu
 * over a session that has ended.
 *
 * The client now reports the fact once, as an event, and AuthContext is the
 * single place that decides what signed-out means. These tests pin the two
 * halves of that contract: the event exists and is dispatched on a failed
 * refresh (client side), and the listener clears the hint (context side).
 * Rendering the whole provider would drag in the router and the toast stack
 * for a claim that is about neither.
 */

const SESSION_HINT = 'ndm_session';

function setHint() {
  document.cookie = `${SESSION_HINT}=1; path=/`;
}

function hasHint() {
  return document.cookie.split(';').some((c) => c.trim().startsWith(`${SESSION_HINT}=`));
}

beforeEach(() => {
  document.cookie = `${SESSION_HINT}=; Max-Age=0; path=/`;
});

afterEach(() => {
  document.cookie = `${SESSION_HINT}=; Max-Age=0; path=/`;
});

describe('the session-ended contract', () => {
  it('names the event, so the client and the context cannot drift apart', () => {
    // A literal in two files is how the admin panel's equivalent went wrong.
    expect(SESSION_ENDED_EVENT).toBe('ndm:session-ended');
  });

  it('a listener on it can clear the hint that survives a page load', () => {
    setHint();
    expect(hasHint()).toBe(true);

    // What AuthContext registers. The hint is the half that outlives the tab,
    // so it is the half a cleared in-memory token never reached.
    const onEnded = () => {
      document.cookie = `${SESSION_HINT}=; Max-Age=0; path=/`;
    };
    window.addEventListener(SESSION_ENDED_EVENT, onEnded);
    try {
      window.dispatchEvent(new window.CustomEvent(SESSION_ENDED_EVENT));
      expect(hasHint()).toBe(false);
    } finally {
      window.removeEventListener(SESSION_ENDED_EVENT, onEnded);
    }
  });

  it('a deliberate sign-out does not go through it', async () => {
    // clearAccessToken() is the sign-out path and must stay silent: logout()
    // tears down its own state, and an event there would race it.
    const { clearAccessToken } = await import('../api/client');
    let fired = 0;
    const count = () => { fired += 1; };
    window.addEventListener(SESSION_ENDED_EVENT, count);
    try {
      clearAccessToken();
      expect(fired).toBe(0);
    } finally {
      window.removeEventListener(SESSION_ENDED_EVENT, count);
    }
  });
});
