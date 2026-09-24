import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import usePageMeta from '../hooks/usePageMeta';
import Section from '../components/Section';
import Card from '../components/Card';
import Button from '../components/Button';
import Input from '../components/Input';
import Turnstile, { turnstileEnabled } from '../components/Turnstile';

const SUPPORT_EMAIL = 'support@nexadownloadmanager.com';

const TOPICS = [
  { value: 'general', label: 'General question' },
  { value: 'bug', label: 'Bug report' },
  { value: 'billing', label: 'Billing & refunds' },
  { value: 'license', label: 'License & seats' },
  { value: 'macos', label: 'macOS interest' },
  { value: 'feature', label: 'Feature request' },
  { value: 'other', label: 'Other' },
];

const TOPIC_PLACEHOLDER = {
  bug: 'What did you try, what happened, and which version of Nexa / OS / browser? Paste the error text if there is one.',
  macos: 'Tell us which Mac (Intel or Apple silicon) and macOS version you use — we will email you when a build is ready.',
  billing: 'Include the email on the account and, if possible, the date and amount of the charge.',
  license: 'Include your license key (NDM-XXXX-XXXX-XXXX) and how many devices you are trying to use.',
};

export default function Contact() {
  usePageMeta({
    title: 'Contact',
    description: 'Contact Nexa Download Manager support: bug reports, billing and refunds, license questions, macOS interest and feature requests.',
  });

  const { user } = useAuth();
  const [params] = useSearchParams();
  const initialTopic = TOPICS.some((t) => t.value === params.get('topic')) ? params.get('topic') : 'general';

  const [name, setName] = useState(user?.name || '');
  const [email, setEmail] = useState(user?.email || '');
  const [topic, setTopic] = useState(initialTopic);
  const [message, setMessage] = useState('');
  const [website, setWebsite] = useState('');   // honeypot — humans never see it
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState(null);
  const [turnstileReset, setTurnstileReset] = useState(0);

  // The session is restored after this page mounts, so prefill once the
  // signed-in user arrives (without overwriting anything already typed).
  useEffect(() => {
    if (!user) return;
    setName((n) => n || user.name || '');
    setEmail((e) => e || user.email || '');
  }, [user]);

  const topicLabel = TOPICS.find((t) => t.value === topic)?.label || 'General question';

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (!email.trim()) {
      setError('Add an email address so we can reply.');
      return;
    }
    if (message.trim().length < 10) {
      setError('Please write at least a sentence.');
      return;
    }
    setSending(true);
    try {
      await api.post('/contact', {
        name: name.trim(), email: email.trim(), topic, message: message.trim(), website,
        ...(turnstileToken ? { turnstileToken } : {}),
      });
      setTurnstileReset((n) => n + 1);
      setSent(true);
      setMessage('');
    } catch (err) {
      setError(err?.response?.data?.error?.message || 'Could not send right now — use the email link below.');
    } finally {
      setSending(false);
    }
  };

  // Fallback for people who would rather use their own mail client.
  const openMailApp = () => {
    const subject = `[Nexa] ${topicLabel}${name.trim() ? ` — ${name.trim()}` : ''}`;
    const body = [
      message.trim(),
      '',
      '—',
      name.trim() ? `Name: ${name.trim()}` : null,
      email.trim() ? `Email: ${email.trim()}` : null,
      `Topic: ${topicLabel}`,
      typeof navigator !== 'undefined' ? `Browser: ${navigator.userAgent}` : null,
    ]
      .filter((line) => line !== null)
      .join('\n');
    window.location.href = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  };

  return (
    <Section>
      <div className="page-intro">
        <span className="eyebrow"><span className="eyebrow-dot" />Get in touch</span>
        <h1 className="mt-5 text-white">Talk to a <span className="text-gradient">human.</span></h1>
        <p>
          Nexa is a small project. Messages go straight to the people who build it, and we reply to
          everything — usually within two working days.
        </p>
      </div>

      <div className="mx-auto mt-12 grid max-w-5xl gap-6 lg:grid-cols-[1.3fr_0.7fr]">
        <Card className="!p-7 sm:!p-8">
          <h2 className="text-lg font-bold text-white">Send a message</h2>
          <p className="mt-1 text-sm text-slate-400">
            Goes straight to the support inbox. We reply to the address you give — nothing else is stored.
          </p>
          {sent && (
            <div role="status" className="note-info mt-4 rounded-xl px-4 py-3 text-sm">
              <span className="font-bold">Sent.</span> Thanks — you will hear back at {email.trim()}.
            </div>
          )}
          <form onSubmit={handleSubmit} className="mt-6 space-y-4" noValidate>
            <label className="hidden" aria-hidden="true">
              Website
              <input type="text" name="website" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                label="Name"
                name="name"
                placeholder="John Doe"
                type="text"
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <Input
                label="Email"
                name="email"
                placeholder="you@example.com"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            {/* Labelled exactly as <Input> labels its fields; this one was set in
                spaced capitals and read as a different kind of thing. */}
            <div className="block">
              <label htmlFor="topic" className="mb-2 block text-xs font-semibold tracking-wide text-slate-300">
                Topic
              </label>
              <select
                id="topic"
                name="topic"
                className="input-field"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
              >
                {TOPICS.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
            <Input
              label="Message"
              name="message"
              as="textarea"
              rows={6}
              required
              placeholder={TOPIC_PLACEHOLDER[topic] || 'How can we help?'}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              error={error}
            />
            <Turnstile onToken={setTurnstileToken} resetKey={turnstileReset} />
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={sending || (turnstileEnabled() && !turnstileToken)}>{sending ? 'Sending…' : 'Send message'}</Button>
              <button type="button" onClick={openMailApp} className="inline-flex min-h-11 items-center text-xs text-slate-500 hover:text-brand-300">
                or open in your mail app
              </button>
              <span className="text-xs text-slate-500">
                · <a href={`mailto:${SUPPORT_EMAIL}`} className="inline-block py-1.5 text-slate-300 hover:text-brand-300">{SUPPORT_EMAIL}</a>
              </span>
            </div>
          </form>
        </Card>

        <div className="space-y-5">
          <Card className="!p-6">
            <h3 className="font-bold text-white">Found a bug?</h3>
            <p className="mt-2 text-sm leading-6 text-slate-400">
              Use the form and pick <strong className="text-slate-200">Bug report</strong>. Tell us
              your OS, the app version and the link you were downloading — that is usually enough
              to reproduce it on the first try.
            </p>
            <div className="mt-4">
              <Button href={`mailto:${SUPPORT_EMAIL}`} variant="ghost">
                Email support instead
              </Button>
            </div>
          </Card>
          <Card className="!p-6">
            <h3 className="font-bold text-white">Before you write</h3>
            <ul className="mt-2 text-sm leading-6 text-slate-400">
              <li><Link to="/faq" className="text-slate-200 hover:text-brand-300">FAQ</Link> — pricing, refunds, platforms</li>
              <li><Link to="/docs/youtube" className="block py-1.5 text-slate-200 hover:text-brand-300">YouTube 403 errors</Link></li>
              <li><Link to="/docs/extension" className="block py-1.5 text-slate-200 hover:text-brand-300">“Nexa: engine unavailable”</Link></li>
              <li><Link to="/docs/license" className="block py-1.5 text-slate-200 hover:text-brand-300">License activation & seats</Link></li>
            </ul>
          </Card>
          <Card className="!p-6">
            <h3 className="font-bold text-white">Refunds</h3>
            <p className="mt-2 text-sm leading-6 text-slate-400">
              Within 14 days of a charge, just ask. Pick &ldquo;Billing &amp; refunds&rdquo; above
              and include the account email.
            </p>
          </Card>
        </div>
      </div>
    </Section>
  );
}
