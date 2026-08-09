import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api, { unwrap } from '../api/client';
import Section from '../components/Section';
import Card from '../components/Card';
import Button from '../components/Button';
import Spinner from '../components/Spinner';

function StatCard({ label, value, icon }) {
  return (
    <Card className="card-hover !p-5">
      <div className="flex items-center gap-4">
        <div className="icon-tile !h-11 !w-11 shrink-0">
          {icon}
        </div>
        <div>
          <p className="text-[0.65rem] font-bold uppercase tracking-[0.12em] text-slate-500">{label}</p>
          <p className="text-xl font-bold text-white">{value}</p>
        </div>
      </div>
    </Card>
  );
}

function LicenseCard({ license }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!license?.licenseKey) return;
    await navigator.clipboard.writeText(license.licenseKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!license) {
    return (
      <Card className="card-hover !p-6">
        <h3 className="font-semibold text-white">License Key</h3>
        <p className="mt-2 text-sm text-zinc-400">No active license found.</p>
      </Card>
    );
  }

  return (
    <Card className="card-hover !p-6">
      <h3 className="font-semibold text-white">License Key</h3>
      <div className="mt-3 flex items-center gap-3">
        <code className="flex-1 break-all rounded-xl border border-white/5 bg-surface-2 px-3 py-2 text-sm text-brand-100 font-mono">
          {license.licenseKey}
        </code>
        <Button variant="ghost" onClick={handleCopy}>
          {copied ? 'Copied!' : 'Copy'}
        </Button>
      </div>
      <div className="mt-3 flex flex-wrap gap-4 text-xs text-slate-500">
        <span>Plan: <span className="font-medium text-zinc-300 capitalize">{license.plan}</span></span>
        <span>Status: <span className="font-medium text-zinc-300 capitalize">{license.status}</span></span>
        {license.expiryDate && (
          <span>
            Expires:{' '}
            <span className="font-medium text-zinc-300">
              {new Date(license.expiryDate).toLocaleDateString()}
            </span>
          </span>
        )}
      </div>
    </Card>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  const [license, setLicense] = useState(null);
  const [loadingLicense, setLoadingLicense] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const fetch = async () => {
      try {
        const res = await api.get('/user/license');
        if (!cancelled) setLicense(unwrap(res));
      } catch {
        // no license — that's fine
      } finally {
        if (!cancelled) setLoadingLicense(false);
      }
    };
    fetch();
    return () => { cancelled = true; };
  }, []);

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

      <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Plan"
          value={user?.subscription?.plan || 'Free'}
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
          value={user?.subscription?.status || 'active'}
          icon={
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <path d="M22 4L12 14.01l-3-3" />
            </svg>
          }
        />
        <StatCard
          label="Email"
          value={user?.email || '—'}
          icon={
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
            </svg>
          }
        />
        <StatCard
          label="Seats"
          value={user?.subscription?.seats || '1'}
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

      <div className="mt-8">
        {loadingLicense ? <Spinner center /> : <LicenseCard license={license} />}
      </div>

      <div className="mt-8 grid gap-6 sm:grid-cols-2">
        <Card className="card-hover !p-6">
          <h3 className="font-semibold text-white">Quick actions</h3>
          <div className="mt-4 flex flex-wrap gap-3">
            <Link to="/download" className="btn btn-primary">Download App</Link>
            <Link to="/pricing" className="btn btn-ghost">Upgrade Plan</Link>
          </div>
        </Card>
        <Card className="card-hover !p-6">
          <h3 className="font-semibold text-white">Need help?</h3>
          <p className="mt-2 text-sm text-zinc-400">
            Check our documentation or reach out to support.
          </p>
          <div className="mt-4">
            <Button
              href="mailto:support@nexadownloadmanager.com"
              variant="ghost"
            >
              Contact Support
            </Button>
          </div>
        </Card>
      </div>
    </Section>
  );
}
