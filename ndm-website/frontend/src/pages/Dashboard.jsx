import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';
import api, { unwrap } from '../api/client';
import { clearPendingTrial, hasPendingTrial, startTrial, trialDaysLeft } from '../api/trial';
import usePageMeta from '../hooks/usePageMeta';
import useBillingOpen from '../hooks/useBillingOpen';
import { formatDate } from '../utils/formatDate';
import Section from '../components/Section';
import Card from '../components/Card';
import Button from '../components/Button';
import Input from '../components/Input';
import Skeleton, { useArrival } from '../components/Skeleton';

function StatCard({ label, value, icon }) {
  return (
    <Card className="card-hover !p-5">
      <div className="flex items-center gap-4">
        {/* Four of these across a 1024px screen are ~210px each, and the tile
            was taking a fifth of that from the number it labels. Below 13rem
            of CARD width — not of window width — the number wins. */}
        <div className="cq-drop-tight icon-tile !h-11 !w-11 shrink-0">
          {icon}
        </div>
        <div className="min-w-0">
          <p className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">{label}</p>
          <p className="truncate text-xl font-bold text-white" title={typeof value === 'string' ? value : undefined}>{value}</p>
        </div>
      </div>
    </Card>
  );
}

/**
 * The license card and the devices card as they will land. These sit side by
 * side in one grid row, so the spinner that stood in for the first — 40% of
 * the window tall — set the height of the row, and the second arrived from
 * nothing a moment later.
 */
function CardSkeleton({ label, lines = 3, action = true }) {
  return (
    <Card className="!p-6" role="status" aria-label={label}>
      <Skeleton className="h-5 w-32 rounded" />
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={`h-3.5 rounded ${i === lines - 1 ? 'w-2/3' : 'w-full'} ${i ? 'mt-3' : 'mt-4'}`} />
      ))}
      {action && <Skeleton className="mt-5 h-11 w-full rounded-xl" />}
    </Card>
  );
}

/**
 * What the date on the key means. "Expires" was printed for every plan, while
 * Billing said "Renews" for the same date — and only a Stripe subscription
 * renews at all; a trial or an admin-granted plan just ends.
 */
function expiryLabel(license, cancelling) {
  if (license.trial) return 'Trial ends';
  if (cancelling) return 'Ends';
  return license.billed ? 'Renews' : 'Active until';
}

function LicenseCard({ license, onRotated, cancelling = false, className = '' }) {
  const [copied, setCopied] = useState(false);
  const [keyShown, setKeyShown] = useState(false);
  const [rotating, setRotating] = useState(false);
  const toast = useToast();
  const confirm = useConfirm();

  const handleCopy = async () => {
    if (!license?.licenseKey) return;
    await navigator.clipboard.writeText(license.licenseKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // The only way to take a key back. Removing somebody from a team does not do
  // it — they were given the owner's real key, and nothing on the server ties a
  // machine to the person who activated it — so a key that has leaked, to an
  // ex-colleague or anywhere else, stays valid until it is replaced.
  const handleRotate = async () => {
    const sure = await confirm({
      title: 'Replace this license key?',
      message: 'The current key stops working immediately and every machine activated with it '
        + 'drops to Free. Machines signed in with an account are not affected. Do this if the key '
        + 'has been shared or you have removed someone from your team.',
      confirmLabel: 'Replace key',
      danger: true,
    });
    if (!sure) return;
    setRotating(true);
    try {
      const res = unwrap(await api.post('/user/license/rotate'));
      toast.success(res.devicesRevoked
        ? `New key issued. ${res.devicesRevoked} device(s) signed out.`
        : 'New key issued.');
      onRotated?.();
    } catch (err) {
      toast.error(err?.response?.data?.error?.message || 'Could not issue a new key.');
    } finally {
      setRotating(false);
    }
  };

  const canRotate = Boolean(license) && !license.viaTeam && license.plan && license.plan !== 'free'
    && license.status === 'active';

  if (!license) {
    return (
      <Card className={`card-hover !p-6 ${className}`.trim()}>
        <h3 className="font-semibold text-white">License key</h3>
        <p className="mt-2 text-sm text-zinc-400">No active license found.</p>
      </Card>
    );
  }

  // The Free plan has nothing a key would unlock — the app starts on Free by
  // itself — so there is no key to show, only the way the account reaches the
  // app: signing in inside it. A trial or upgrade then follows on its own.
  if (license.plan === 'free' && !license.trial) {
    return (
      <Card className={`card-hover !p-6 ${className}`.trim()} data-testid="account-signin-card">
        <h3 className="font-semibold text-white">Use your account in the app</h3>
        <p className="mt-2 text-sm leading-6 text-slate-400">
          No license key needed. In Nexa Download Manager open{' '}
          <span className="font-medium text-slate-200">Settings &rarr; Account &rarr; Sign in with Nexa</span>, approve the
          code that opens here, and this account&rsquo;s plan follows you &mdash; a trial or an upgrade reaches the app on
          its own.
        </p>
        <p className="mt-3 text-xs leading-5 text-slate-500">
          No Account section in Settings? That machine is on an older version &mdash;{' '}
          <Link to="/download" className="text-slate-300 hover:text-brand-300">update Nexa</Link> and it appears.{' '}
          <Link to="/docs/license" className="text-slate-300 hover:text-brand-300">How signing in works</Link>
        </p>
      </Card>
    );
  }

  return (
    <Card className={`card-hover !p-6 ${className}`.trim()}>
      <h3 className="font-semibold text-white">License key</h3>
      <p className="mt-2 text-xs leading-5 text-slate-500">
        Signing in inside the app (Settings &rarr; Account) is all you need. This key is only for activating by
        hand &mdash; an older version of Nexa, or a machine you set up without signing in.
      </p>
      <div className="mt-3 flex items-center gap-3">
        <code className="flex-1 break-all rounded-xl border border-white/5 bg-surface-2 px-3 py-2 text-sm text-brand-100 font-mono">
          {keyShown ? license.licenseKey : license.licenseKey.replace(/[^-]/g, '\u2022')}
        </code>
        <Button
          variant="ghost"
          onClick={() => setKeyShown((v) => !v)}
          aria-pressed={keyShown}
        >
          {keyShown ? 'Hide' : 'Show'}
        </Button>
        <Button variant="ghost" onClick={handleCopy}>
          {copied ? 'Copied!' : 'Copy'}
        </Button>
      </div>
      <div className="mt-3 flex flex-wrap gap-4 text-xs text-slate-500">
        {license.viaTeam && (
          <span>Shared by: <span className="font-medium text-zinc-300">{license.teamOwner}</span></span>
        )}
        {license.expiryDate && (
          <span>
            {expiryLabel(license, cancelling)}:{' '}
            <span className="font-medium text-zinc-300">
              {formatDate(license.expiryDate) || '—'}
            </span>
          </span>
        )}
      </div>
      <p className="mt-3 text-xs text-slate-500">
        Manual activation: Settings &rarr; Account &rarr; &ldquo;Use a license key instead&rdquo;.{' '}
        <Link to="/docs/license" className="text-slate-300 hover:text-brand-300">How activation works</Link>
      </p>
      {canRotate && (
        <div className="mt-4 border-t border-white/5 pt-4">
          <Button variant="ghost" onClick={handleRotate} disabled={rotating}>
            {rotating ? 'Replacing…' : 'Replace key'}
          </Button>
          <p className="mt-2 text-xs text-slate-500">
            Issues a new key and signs every machine out of the old one. Use this if the key
            has been shared, or after removing someone from your team.
          </p>
        </div>
      )}
    </Card>
  );
}

function timeAgo(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const min = Math.round(ms / 60000);
  if (min < 2) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/**
 * Seats are concurrent: a license covers N machines AT A TIME. This is where
 * a user frees one when the app on another machine is holding it.
 */
function DevicesCard({ onChanged }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const arrive = useArrival(data === null);

  const load = async () => {
    try {
      setData(unwrap(await api.get('/user/devices')));
    } catch {
      setData({ seats: 0, activeSeats: 0, devices: [] });
    }
  };

  // The desktop app claims and frees seats while this page sits open, so a
  // one-shot fetch goes stale the moment the app activates. Keep the card
  // live: refresh every 30s and whenever the tab regains focus.
  useEffect(() => {
    load();
    const timer = setInterval(load, 30_000);
    const onFocus = () => { if (!document.hidden) load(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
     
  }, []);

  const release = async (device) => {
    setBusyId(device.shortId);
    try {
      await api.delete(`/user/devices/${device.id}`);
      toast.success(`Freed the seat ${device.name} was holding.`);
      await load();
      onChanged?.();
    } catch (err) {
      toast.error(err?.response?.data?.error?.message || 'Could not free that seat.');
    } finally {
      setBusyId(null);
    }
  };

  // Signing a machine out revokes its device token: the app on it drops to
  // Free at its next check and forgets the account. Its seat is freed too.
  const signOut = async (device) => {
    setBusyId(device.shortId);
    try {
      await api.delete(`/user/devices/tokens/${device.tokenId}`);
      toast.success(`Signed ${device.name} out.`);
      await load();
      onChanged?.();
    } catch (err) {
      toast.error(err?.response?.data?.error?.message || 'Could not sign that device out.');
    } finally {
      setBusyId(null);
    }
  };

  if (!data) return <CardSkeleton label="Loading your devices" lines={2} />;
  const { seats = 0, activeSeats = 0, seatsEnforced = seats > 0, devices = [] } = data;

  return (
    <Card className={`card-hover !p-6 ${arrive}`.trim()}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold text-white">Your devices</h3>
          <p className="mt-1 text-xs text-slate-500">
            {seatsEnforced
              ? `${seats} seat${seats === 1 ? '' : 's'} · ${activeSeats} in use right now. Quitting Nexa frees its seat at once; closing the window keeps it running in the tray. After a crash or lost connection, the seat frees itself within 15 minutes.`
              : 'Every computer signed in to this account. The Free plan has no seat limit.'}
          </p>
        </div>
        {seatsEnforced && (
          <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${activeSeats >= seats && seats > 0 ? 'bg-amber-500/15 text-amber-300' : 'bg-emerald-500/15 text-emerald-300'}`}>
            {activeSeats}/{seats} in use
          </span>
        )}
      </div>
      {devices.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="text-slate-600" aria-hidden="true">
            <rect x="2" y="3" width="20" height="14" rx="2" />
            <path d="M8 21h8M12 17v4" />
          </svg>
          <p className="text-sm font-semibold text-slate-300">No computer is signed in yet</p>
          <p className="max-w-xs text-sm leading-6 text-slate-500">
            In the app, open Settings &rarr; Account and sign in with this account. It appears
            here within seconds.
          </p>
        </div>
      ) : (
        <ul className="mt-4 divide-y divide-[var(--color-surface-border)]" data-testid="device-list">
          {devices.map((d) => (
            <li key={d.shortId} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-white">
                  {d.name}
                  <span className="ml-2 font-mono text-[0.7rem] font-normal text-slate-500">{d.shortId}</span>
                  {d.signedIn && (
                    <span className="ml-2 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-200">
                      Signed in
                    </span>
                  )}
                </p>
                <p className="mt-0.5 text-xs text-slate-500">
                  {d.signedIn ? (d.appVersion ? `Nexa ${d.appVersion}` : 'Signed in with your account') : 'Activated with a license key'}
                  {seatsEnforced ? (d.active ? ' · holding a seat' : ' · not holding a seat') : ''}
                  {d.lastSeenAt ? ` · last seen ${timeAgo(d.lastSeenAt)}` : ''}
                </p>
              </div>
              {d.signedIn ? (
                <Button variant="ghost" onClick={() => signOut(d)} disabled={busyId === d.shortId}>
                  {busyId === d.shortId ? 'Signing out…' : 'Sign out'}
                </Button>
              ) : d.active && (
                <Button variant="ghost" onClick={() => release(d)} disabled={busyId === d.shortId}>
                  {busyId === d.shortId ? 'Freeing…' : 'Free this seat'}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/**
 * Team roster. Owners of a Team plan invite by email and remove people;
 * members see whose team they are on and can leave. Everyone else sees
 * nothing — the card only renders when there is a team to show.
 */
function TeamCard({ onChanged }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [team, setTeam] = useState(null);
  const [email, setEmail] = useState('');
  const [inviting, setInviting] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      setTeam(unwrap(await api.get('/team')));
    } catch {
      setTeam({ role: 'none' });
    }
  };

  useEffect(() => { load(); }, []);

  const invite = async (e) => {
    e.preventDefault();
    setError('');
    setInviting(true);
    try {
      await api.post('/team/invites', { email: email.trim() });
      toast.success(`Invitation sent to ${email.trim()}.`);
      setEmail('');
      await load();
    } catch (err) {
      setError(err?.response?.data?.error?.message || 'Could not send the invitation.');
    } finally {
      setInviting(false);
    }
  };

  const resend = async (member) => {
    setBusyId(member.id);
    try {
      await api.post(`/team/invites/${member.id}/resend`);
      toast.success(`Invitation re-sent to ${member.email}.`);
    } catch (err) {
      toast.error(err?.response?.data?.error?.message || 'Could not re-send the invitation.');
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (member) => {
    const pending = member.status === 'invited';
    const sure = await confirm({
      title: pending ? 'Withdraw this invitation?' : `Remove ${member.name || member.email}?`,
      message: pending
        ? `${member.email} will no longer be able to accept.`
        // Deliberately blunt: this used to promise that their app "returns to
        // Free at its next check", which is not true. They were given the
        // owner's real license key and it keeps working until it is replaced.
        : 'They stop appearing on your team, but the license key they already have keeps working. '
          + 'To actually cut off their access, use “Replace key” on your License card afterwards.',
      confirmLabel: pending ? 'Withdraw' : 'Remove',
      danger: true,
    });
    if (!sure) return;
    setBusyId(member.id);
    try {
      await api.delete(`/team/members/${member.id}`);
      if (pending) toast.success('Invitation withdrawn.');
      else toast.success(`${member.email} removed. Replace your license key to revoke the copy they have.`);
      await load();
    } catch (err) {
      toast.error(err?.response?.data?.error?.message || 'Could not remove that person.');
    } finally {
      setBusyId(null);
    }
  };

  const leave = async () => {
    const sure = await confirm({
      title: `Leave ${team.owner.name}'s team?`,
      // Leaving only edits the roster (routes/team.js). A machine that was
      // activated by typing the team's key still holds that key, as the
      // owner's Remove dialog says.
      message: 'The team license key disappears from your dashboard, and computers signed in with your '
        + 'account return to your own plan at their next check. '
        + 'A computer activated with the team’s license key keeps it until the owner replaces the key.',
      confirmLabel: 'Leave team',
      danger: true,
    });
    if (!sure) return;
    setBusyId('leave');
    try {
      await api.post('/team/leave');
      toast.success('You left the team.');
      await load();
      onChanged?.();
    } catch (err) {
      toast.error(err?.response?.data?.error?.message || 'Could not leave the team.');
    } finally {
      setBusyId(null);
    }
  };

  if (!team || team.role === 'none') return null;

  if (team.role === 'member') {
    return (
      <Card className="card-hover !p-6">
        <h3 className="font-semibold text-white">Your team</h3>
        <p className="mt-2 text-sm text-zinc-400">
          You are on <span className="font-semibold text-white">{team.owner.name}</span>&rsquo;s{' '}
          <span className="capitalize">{team.plan}</span> plan
          {team.usable ? '. The team license key is shown above.' : ', which is not active right now.'}
        </p>
        <div className="mt-4">
          <Button variant="ghost" onClick={leave} disabled={busyId === 'leave'}>
            {busyId === 'leave' ? 'Leaving…' : 'Leave team'}
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card className="card-hover !p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold text-white">Your team</h3>
          <p className="mt-1 text-xs text-slate-500">
            {team.seats} people on one key, five machines at a time. Members get the key on their own dashboard.
          </p>
        </div>
        <span className="rounded-full bg-brand-400/15 px-2.5 py-1 text-xs font-bold text-brand-100">
          {team.used}/{team.seats} people
        </span>
      </div>

      <ul className="mt-4 divide-y divide-[var(--color-surface-border)]">
        {team.members.map((m) => (
          <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-white">{m.name || m.email}</p>
              <p className="mt-0.5 truncate text-xs text-slate-500">
                {m.name ? `${m.email} · ` : ''}
                {m.status === 'active' ? `joined ${timeAgo(m.acceptedAt) || 'recently'}` : `invited ${timeAgo(m.invitedAt) || 'just now'} · pending`}
              </p>
            </div>
            <div className="flex gap-2">
              {m.status === 'invited' && (
                <Button variant="ghost" onClick={() => resend(m)} disabled={busyId === m.id}>Re-send</Button>
              )}
              <Button variant="ghost" onClick={() => remove(m)} disabled={busyId === m.id}>
                {m.status === 'invited' ? 'Withdraw' : 'Remove'}
              </Button>
            </div>
          </li>
        ))}
        {team.members.length === 0 && (
          <li className="py-3 text-sm text-zinc-500">Nobody has been invited yet.</li>
        )}
      </ul>

      {/* cq-row, not sm:flex-row: this card sits in a sm:grid-cols-2 grid, so
          at a 640px window the card is about 300px wide — and sm: chose that
          exact moment to put the field and the button side by side. The
          container query asks the card how much room there is instead. */}
      {team.canInvite ? (
        <form onSubmit={invite} className="cq-row mt-4">
          <div className="flex-1">
            <Input
              label="Invite by email"
              name="inviteEmail"
              type="email"
              required
              placeholder="colleague@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={error || undefined}
            />
          </div>
          <Button type="submit" disabled={inviting || !email.trim()}>
            {inviting ? 'Sending…' : 'Send invite'}
          </Button>
        </form>
      ) : (
        <p className="mt-4 text-xs text-slate-500">
          {team.usable ? 'Every place on this plan is taken. Remove someone to invite another.' : 'This plan is not active, so invitations are paused.'}
        </p>
      )}
    </Card>
  );
}

function TrialBanner({ subscription, onStart, starting, billingOpen }) {
  if (subscription?.trial) {
    const days = trialDaysLeft(subscription.trialEndsAt);
    return (
      <div className="mt-6 flex flex-col gap-3 rounded-xl border border-accent-400/35 bg-accent-500/10 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-sm text-accent-300">
          <span className="font-bold text-white">Pro trial</span>
          {' · '}
          {days === 0 ? 'ends today' : `${days} day${days === 1 ? '' : 's'} left`}
          {subscription.trialEndsAt && (
            <span className="text-slate-400">
              {' '}(until {formatDate(subscription.trialEndsAt)})
            </span>
          )}
        </div>
        <div className="flex items-center gap-4">
          {/* Ending it early lives on Billing with its warning; from here it is
              a link, so the banner keeps one primary action. */}
          <Link to="/billing" className="text-sm text-slate-400 underline-offset-2 hover:text-slate-200 hover:underline">
            End trial
          </Link>
          {/* "Upgrade" only while there is something to buy: with billing off,
              Pricing answers it with "Paid plans coming soon". */}
          {billingOpen ? (
            <Link to="/pricing" className="btn btn-primary">Upgrade</Link>
          ) : (
            <Link to="/pricing" className="btn btn-ghost">Compare plans</Link>
          )}
        </div>
      </div>
    );
  }

  const isFree = (subscription?.plan || 'free') === 'free';
  if (isFree && !subscription?.trialEndsAt) {
    return (
      <div className="mt-6 flex flex-col gap-3 rounded-xl border border-brand-400/30 bg-brand-400/10 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-sm text-brand-100">
          <span className="font-bold text-white">Try Pro free for 7 days.</span>{' '}
          Unlimited concurrent downloads and AI rename — no card needed.
        </div>
        <Button onClick={onStart} disabled={starting}>
          {starting ? 'Starting…' : 'Start your free 7-day Pro trial'}
        </Button>
      </div>
    );
  }
  return null;
}

export default function Dashboard() {
  usePageMeta({ title: 'Dashboard', description: 'Your Nexa Download Manager account: plan, signed-in devices and billing.' });

  const { user, refreshMe } = useAuth();
  const toast = useToast();
  const billingOpen = useBillingOpen();
  const [license, setLicense] = useState(null);
  const [loadingLicense, setLoadingLicense] = useState(true);
  const licenseArrives = useArrival(loadingLicense);
  const [startingTrial, setStartingTrial] = useState(false);
  const redeemed = useRef(false);

  const subscription = user?.subscription;
  // The server reports the plan this account HAS: a member's own row stays
  // Free, so it sends the team's plan with viaTeam set. Deriving that here
  // from "team block present AND my plan is free" is what put a member on
  // "Free" with a trial offer while the team card said otherwise.
  const viaTeam = Boolean(subscription?.viaTeam);

  const loadLicense = async () => {
    try {
      const res = await api.get('/user/license');
      setLicense(unwrap(res));
    } catch {
      // no license — that's fine
    } finally {
      setLoadingLicense(false);
    }
  };

  useEffect(() => {
    loadLicense();
  }, []);

  const handleStartTrial = async () => {
    setStartingTrial(true);
    try {
      const result = await startTrial();
      if (result.started) toast.success('Your 7-day Pro trial has started.');
      else toast.info('This account has already used its Pro trial.');
      await refreshMe();
      await loadLicense();
    } catch (err) {
      toast.error(err?.response?.data?.error?.message || 'Could not start the trial.');
    } finally {
      setStartingTrial(false);
    }
  };

  // Redeem a trial requested during registration (/register?trial=1) once.
  useEffect(() => {
    if (redeemed.current || !user || !hasPendingTrial()) return;
    redeemed.current = true;
    clearPendingTrial();
    if (subscription?.trial || subscription?.trialEndsAt || (subscription?.plan && subscription.plan !== 'free')) return;
    handleStartTrial();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  return (
    <Section>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-4xl font-extrabold tracking-tight text-white">Your <span className="text-gradient">command center.</span></h1>
          <p className="mt-2 text-sm text-slate-400">
            Welcome back, {user?.name || user?.email || 'User'}.
          </p>
        </div>
        <div className="flex gap-3">
          <Link to="/billing" className="btn btn-ghost">Billing</Link>
          <Link to="/profile" className="btn btn-ghost">Profile</Link>
        </div>
      </div>

      {!viaTeam && (
        <TrialBanner
          subscription={subscription}
          onStart={handleStartTrial}
          starting={startingTrial}
          billingOpen={billingOpen === true}
        />
      )}

      <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Plan"
          value={
            <span className="capitalize">
              {viaTeam ? 'Team' : (subscription?.plan || 'Free')}
              {subscription?.trial && !viaTeam && <span className="ml-2 text-xs font-semibold uppercase tracking-wide text-accent-300">Trial</span>}
              {viaTeam && <span className="ml-2 text-xs font-semibold uppercase tracking-wide text-brand-300">via team</span>}
            </span>
          }
          icon={
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 12V8H6a2 2 0 0 1-2-2c0-1.1.9-2 2-2h12v4" />
              <path d="M4 6v12c0 1.1.9 2 2 2h14v-4" />
              <path d="M18 12a2 2 0 0 0 0 4h4v-4h-4z" />
            </svg>
          }
        />
        <StatCard
          label="Status"
          value={<span className="capitalize">{subscription?.status || 'active'}</span>}
          icon={
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <path d="M22 4L12 14.01l-3-3" />
            </svg>
          }
        />
        <StatCard
          label="Email"
          value={<span className="text-base">{user?.email || '—'}</span>}
          icon={
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
            </svg>
          }
        />
        <StatCard
          label="Seats"
          value={subscription?.seats || '1'}
          icon={
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          }
        />
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        {loadingLicense ? (
          <CardSkeleton label="Loading your license" />
        ) : (
          <LicenseCard
            license={license}
            onRotated={loadLicense}
            cancelling={Boolean(subscription?.cancelAtPeriodEnd)}
            className={licenseArrives}
          />
        )}
        <DevicesCard />
        <TeamCard onChanged={() => { loadLicense(); refreshMe(); }} />
      </div>

      <div className="mt-8 grid gap-6 sm:grid-cols-2">
        <Card className="card-hover !p-6">
          <h3 className="font-semibold text-white">Quick actions</h3>
          <div className="mt-4 flex flex-wrap gap-3">
            <Link to="/download" className="btn btn-primary">Download the app</Link>
            {/* An upgrade is only offered while one can be bought. With billing
                off, "Upgrade to Team" led to a Team card reading "Coming soon". */}
            <Link to="/pricing" className="btn btn-ghost">
              {billingOpen !== true || subscription?.plan === 'team' ? 'Compare plans'
                : subscription?.plan === 'pro' ? 'Upgrade to Team' : 'Upgrade plan'}
            </Link>
            <Link to="/docs" className="btn btn-ghost">Docs</Link>
          </div>
        </Card>
        <Card className="card-hover !p-6">
          <h3 className="font-semibold text-white">Need help?</h3>
          <p className="mt-2 text-sm text-zinc-400">
            Check the <Link to="/faq" className="text-slate-200 hover:text-brand-300">FAQ</Link> and{' '}
            <Link to="/docs" className="text-slate-200 hover:text-brand-300">documentation</Link>, or reach out to support.
          </p>
          <div className="mt-4">
            <Button to="/contact" variant="ghost">
              Contact support
            </Button>
          </div>
        </Card>
      </div>
    </Section>
  );
}
