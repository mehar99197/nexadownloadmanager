import { useEffect, useState, useCallback } from 'react';
import api, { unwrap } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/Toast';
import Section from '../components/Section';
import Card from '../components/Card';
import Button from '../components/Button';
import Input from '../components/Input';
import StarRating from '../components/StarRating';
import Spinner from '../components/Spinner';
import Turnstile, { turnstileEnabled } from '../components/Turnstile';
import usePageMeta from '../hooks/usePageMeta';

const PAGE_SIZE = 10;

/* Reviews carry a rating and a comment and nothing else, so "what did you use
   it for" is not a stored field. Rather than invent one, these filter the text
   people actually wrote — honest about being a word match, and useful the
   moment there are enough reviews for it to matter. */
const USE_CASES = [
  { id: 'youtube', label: 'For YouTube', words: ['youtube', 'video', 'playlist', 'yt-dlp'] },
  { id: 'torrents', label: 'For torrents', words: ['torrent', 'magnet', 'seed'] },
  { id: 'daily', label: 'For daily use', words: ['daily', 'every day', 'everyday', 'work', 'speed', 'fast'] },
  { id: 'linux', label: 'On Linux', words: ['linux', 'ubuntu', 'debian'] },
];

const matchesUseCase = (review, useCase) => {
  if (!useCase) return true;
  const def = USE_CASES.find((u) => u.id === useCase);
  if (!def) return true;
  const text = `${review.comment || ''}`.toLowerCase();
  return def.words.some((w) => text.includes(w));
};

function RatingBreakdown({ breakdown, averageRating }) {
  // The breakdown is site-wide while totalCount follows the active star filter,
  // so bars scale against the breakdown's own total — never the filtered count
  // (a 5★ filter drew bars past 100%) and never zero (width: NaN%).
  const allReviews = Object.values(breakdown || {}).reduce((a, b) => a + (Number(b) || 0), 0);

  return (
    <Card className="rating-card !p-6">
      <div className="text-center">
        <div className="text-4xl font-extrabold text-white">
          {allReviews > 0 && averageRating != null ? Number(averageRating).toFixed(1) : '—'}
        </div>
        <StarRating value={averageRating || 0} readOnly size={18} className="mt-1 justify-center" />
        <p className="mt-1 text-xs text-zinc-500">{allReviews} review{allReviews !== 1 ? 's' : ''}</p>
      </div>
      <div className="mt-6 space-y-2.5">
        {[5, 4, 3, 2, 1].map((star) => {
          const count = breakdown?.[star] || 0;
          const pct = allReviews ? (count / allReviews) * 100 : 0;
          return (
            <div key={star} className="flex items-center gap-2 text-xs">
              <span className="w-3 text-zinc-400">{star}</span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-accent-400 to-brand-400"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="w-6 text-right text-zinc-500">{count}</span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function ReviewForm({ onSubmitted }) {
  const { isAuthenticated } = useAuth();
  const toast = useToast();
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [turnstileToken, setTurnstileToken] = useState(null);
  const [turnstileReset, setTurnstileReset] = useState(0);

  if (!isAuthenticated) return null;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (rating < 1) {
      setError('Please select a rating.');
      return;
    }
    if (!comment.trim()) {
      setError('Please write a review.');
      return;
    }
    setSubmitting(true);
    try {
      await api.post('/reviews', {
        rating, comment: comment.trim(), ...(turnstileToken ? { turnstileToken } : {}),
      });
      setTurnstileReset((n) => n + 1);
      toast.success('Review submitted! It will appear after approval.');
      setRating(0);
      setComment('');
      onSubmitted();
    } catch (err) {
      const msg =
        err?.response?.data?.error?.message ||
        err?.message ||
        'Failed to submit review.';
      setError(msg);
      setTurnstileReset((n) => n + 1);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card className="!p-7">
      <h3 className="text-lg font-bold text-white">Write a review</h3>
      <p className="mt-1.5 text-xs leading-5 text-slate-500">
        Every review is read by a human before it appears, and we do not edit or remove one for
        being critical. That is the only reason the ones below are worth anything.
      </p>
      <form onSubmit={handleSubmit} className="mt-4 space-y-4">
        <div>
          <span className="mb-1.5 block text-sm font-medium text-zinc-200">Rating</span>
          <StarRating value={rating} onChange={setRating} size={24} />
        </div>
        <Input
          label="Your review"
          name="comment"
          as="textarea"
          placeholder="Share your experience…"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
        {error && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-sm text-red-300">
            {error}
          </div>
        )}
        <Turnstile onToken={setTurnstileToken} resetKey={turnstileReset} />
        <Button type="submit" disabled={submitting || (turnstileEnabled() && !turnstileToken)}>
          {submitting ? 'Submitting…' : 'Submit review'}
        </Button>
      </form>
    </Card>
  );
}

export default function Reviews() {
  usePageMeta({ title: "Reviews", description: "What people say about Nexa Download Manager — real, moderated reviews from users." });

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState('');
  const [useCase, setUseCase] = useState('');

  const fetchReviews = useCallback(async (p, ratingFilter) => {
    setLoading(true);
    setError('');
    try {
      const params = { page: p, limit: PAGE_SIZE };
      if (ratingFilter) params.rating = ratingFilter;
      const res = await api.get('/reviews', { params });
      setData(unwrap(res));
    } catch {
      setError('Failed to load reviews.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchReviews(page, filter);
  }, [page, filter, fetchReviews]);

  const handleFilter = (star) => {
    setFilter(star === filter ? '' : star);
    setPage(1);
  };

  const totalPages = data ? Math.ceil(data.totalCount / PAGE_SIZE) : 0;
  const totalReviews = Object.values(data?.ratingBreakdown || {})
    .reduce((a, b) => a + (Number(b) || 0), 0);
  const visibleReviews = (data?.reviews || []).filter((r) => matchesUseCase(r, useCase));
  // Featured: the strongest ratings with enough written down to be worth
  // reading. Only on an unfiltered first page, or it competes with the filter
  // the reader just applied.
  const featured = (!filter && !useCase && page === 1)
    ? [...(data?.reviews || [])]
        .filter((r) => (r.comment || '').length > 120 && r.rating >= 4)
        .sort((a, b) => b.rating - a.rating || (b.comment || '').length - (a.comment || '').length)
        .slice(0, 3)
    : [];

  return (
    <Section>
      <div className="page-intro">
        <span className="eyebrow"><span className="eyebrow-dot" />From the queue</span>
        <h1 className="mt-5 text-white">Loved by people who <span className="text-gradient">move fast.</span></h1>
        <p>Real experiences from real downloaders. No inflated promises, just work that gets out of the way.</p>
      </div>

      {totalReviews > 0 && (
        <div className="mx-auto mt-6 flex max-w-xl flex-wrap items-center justify-center gap-x-4 gap-y-2">
          <span className="text-3xl font-extrabold text-white">
            {Number(data.averageRating).toFixed(1)}
          </span>
          <StarRating value={data.averageRating || 0} readOnly size={20} />
          <span className="text-sm text-slate-400">
            out of 5 · {totalReviews} review{totalReviews !== 1 ? 's' : ''}
          </span>
        </div>
      )}

      {loading && !data ? (
        <Spinner center />
      ) : error && !data ? (
        <div className="mt-10 text-center">
          <p className="text-red-300">{error}</p>
        </div>
      ) : data ? (
        <div className="mt-10 grid gap-8 lg:grid-cols-[1fr_280px]">
          <div className="space-y-5">
            {featured.length > 0 && (
              <div>
                <h2 className="text-sm font-bold uppercase tracking-[0.14em] text-brand-300">
                  Most detailed
                </h2>
                <div className="mt-3 grid gap-4 sm:grid-cols-2">
                  {featured.map((r) => (
                    <Card key={`feat-${r.id}`} className="!p-5">
                      <StarRating value={r.rating} readOnly size={14} />
                      <p className="mt-2.5 text-sm leading-6 text-zinc-300">“{r.comment}”</p>
                      <p className="mt-3 text-xs font-semibold text-slate-400">
                        {r.userName || 'Anonymous'}
                        {r.plan ? <span className="ml-2 font-normal text-slate-500">on {r.plan}</span> : null}
                      </p>
                    </Card>
                  ))}
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              {USE_CASES.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                    useCase === u.id
                      ? 'on-brand'
                      : 'border border-white/5 bg-surface-2 text-slate-400 hover:text-white'
                  }`}
                  onClick={() => setUseCase(useCase === u.id ? '' : u.id)}
                >
                  {u.label}
                </button>
              ))}
              {useCase && (
                <span className="text-xs text-slate-500">matches the words people wrote</span>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {[5, 4, 3, 2, 1].map((star) => (
                <button
                  key={star}
                  type="button"
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                    filter === String(star)
                      ? 'on-brand'
                      : 'border border-white/5 bg-surface-2 text-slate-400 hover:text-white'
                  }`}
                  onClick={() => handleFilter(String(star))}
                >
                  {star} ★
                </button>
              ))}
            </div>

            {visibleReviews.length === 0 ? (
              <Card className="!p-7 text-center">
                <p className="text-sm font-bold text-white">
                  {filter || useCase ? 'Nothing matches that filter yet.' : 'No reviews yet.'}
                </p>
                <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-400">
                  {filter || useCase
                    ? 'Clear the filters to see everything.'
                    : 'Nexa is new, so there is nothing here to inflate and nothing borrowed from elsewhere. If you have used it, yours would be the first — good or bad.'}
                </p>
                <div className="mt-5 flex flex-wrap justify-center gap-3">
                  {(filter || useCase) ? (
                    <Button variant="ghost" onClick={() => { setFilter(''); setUseCase(''); setPage(1); }}>
                      Clear filters
                    </Button>
                  ) : (
                    <>
                      <Button to="/download">Try it first</Button>
                      <Button to="/login?next=/reviews" variant="ghost">Sign in to review</Button>
                    </>
                  )}
                </div>
              </Card>
            ) : (
              visibleReviews.map((r) => (
                <Card key={r.id} className="card-hover !p-6">
                  <div className="flex items-center gap-3">
                    <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--color-brand-500)]/15 text-sm font-bold text-brand-300">
                      {(r.userName || 'U')[0].toUpperCase()}
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-white">{r.userName || 'Anonymous'}</p>
                      <StarRating value={r.rating} readOnly size={14} />
                    </div>
                  </div>
                  {r.comment && (
                    <p className="mt-3 text-sm leading-relaxed text-zinc-300">{r.comment}</p>
                  )}
                </Card>
              ))
            )}

            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-2 pt-4">
                <Button
                  variant="ghost"
                  disabled={page <= 1 || loading}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Previous
                </Button>
                <span className="text-sm text-zinc-400">
                  {page} / {totalPages}
                </span>
                <Button
                  variant="ghost"
                  disabled={page >= totalPages || loading}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                >
                  Next
                </Button>
              </div>
            )}
          </div>

          <div className="space-y-5">
            <RatingBreakdown breakdown={data.ratingBreakdown} averageRating={data.averageRating} />
            <ReviewForm onSubmitted={() => fetchReviews(page, filter)} />
          </div>
        </div>
      ) : null}
    </Section>
  );
}
