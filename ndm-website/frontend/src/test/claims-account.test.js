/**
 * The account pages say what the server and the app actually do.
 *
 * Each pair below is a sentence the audit found false against the code and
 * the fact that replaced it:
 *
 *  - Register and Login said "Account created" after every sign-up. For an
 *    address that already has an account, none is created and an "account
 *    exists" email goes out instead (routes/auth.js). The reply is kept
 *    identical on purpose, so the page cannot tell. It now says what is true
 *    either way: check your inbox.
 *  - Login pointed at "Continue with Google" below; the button is above.
 *  - Dashboard said a seat frees itself 15 minutes after the app closes. Quitting
 *    releases it at once (main.cpp releaseSeat). Only a crash or lost
 *    connection waits out the 15-minute lease. Closing the window hides Nexa
 *    to the tray, where it keeps its seat.
 *  - Leaving a team only edits the roster (routes/team.js). A computer
 *    activated with the team's key keeps it until the owner replaces it.
 *  - Billing promised "every invoice" in a list that shows the 20 newest
 *    (models/Payment.js).
 *  - Activate blamed a refused code on "physical access". Anyone can make a
 *    code on any machine and send the link (routes/device.js).
 *  - Profile said deletion erases "everything" and "payment history". Payment
 *    records are kept for tax (payments.user_id ON DELETE SET NULL), and the
 *    privacy policy lists the rest.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// The base goes through a variable: Vite rewrites a literal
// `new URL('…', import.meta.url)` into a root-relative asset URL under jsdom.
const HERE = import.meta.url;
const page = (name) => readFileSync(new URL(`../pages/${name}`, HERE), 'utf8');

describe('account pages — claims match the code', () => {
  it('sign-up never claims an account was created', () => {
    expect(page('Register.jsx')).not.toMatch(/Account created! /);
    expect(page('Login.jsx')).not.toMatch(/>Account created\.</);
    expect(page('Login.jsx')).toMatch(/Check your inbox/);
  });

  it('points at the Google button where it is', () => {
    expect(page('Login.jsx')).not.toMatch(/Continue with Google” below/);
    expect(page('Login.jsx')).toMatch(/Continue with Google” above/);
  });

  it('describes when a seat frees', () => {
    const dashboard = page('Dashboard.jsx');
    expect(dashboard).not.toMatch(/frees itself 15 minutes after the app closes/);
    expect(dashboard).toMatch(/Quitting Nexa frees its seat at once/);
  });

  // A paid plan's cap is the "Max simultaneous downloads" setting, 1 to 32
  // (SettingsDialog.cpp; DownloadEngine.cpp), not unlimited.
  it('does not sell the trial as unlimited downloads', () => {
    const dashboard = page('Dashboard.jsx');
    expect(dashboard).not.toMatch(/Unlimited concurrent downloads/);
    expect(dashboard).toMatch(/Up to 32 downloads at once/);
  });

  it('says what leaving a team does to a computer on the team key', () => {
    const dashboard = page('Dashboard.jsx');
    expect(dashboard).not.toMatch(/and the app returns to your own plan\.'/);
    expect(dashboard).toMatch(/activated with the team’s license key keeps it/);
  });

  it('does not promise every invoice in a list of the newest 20', () => {
    expect(page('Billing.jsx')).not.toMatch(/every invoice shows up here/);
  });

  it('does not blame a refused code on physical access', () => {
    expect(page('Activate.jsx')).not.toMatch(/physical access/);
  });

  it('does not promise that deletion erases payment records', () => {
    const profile = page('Profile.jsx');
    expect(profile).not.toMatch(/devices, payment history, review/);
    expect(profile).not.toMatch(/Everything tied to/);
    expect(profile).toMatch(/kept for tax/);
  });
});
