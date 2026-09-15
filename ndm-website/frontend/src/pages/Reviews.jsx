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

  return (
    <Section>
      <div className="page-intro">
        <span className="eyebrow"><span className="eyebrow-dot" />From the queue</span>
        <h1 className="mt-5 text-white">Loved by people who <span className="text-gradient">move fast.</span></h1>
        <p>Real experiences from real downloaders. No inflated promises, just work that gets out of the way.</p>
      </div>

      {loading && !data ? (
        <Spinner center />
      ) : error && !data ? (
        <div className="mt-10 text-center">
          <p className="text-red-300">{error}</p>
        </div>
      ) : data ? (
        <div className="mt-10 grid gap-8 lg:grid-cols-[1fr_280px]">
          <div className="space-y-5">
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

            {(data.reviews || []).length === 0 ? (
              <p className="text-zinc-500">
                {filter ? `No ${filter}-star reviews yet.` : 'No reviews yet. Be the first!'}
              </p>
            ) : (
              (data.reviews || []).map((r) => (
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
