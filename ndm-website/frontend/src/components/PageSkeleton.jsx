import { useLocation } from 'react-router-dom';
import Skeleton from './Skeleton';

/**
 * What a page looks like before it is here.
 *
 * Shown in two places: while a page's code is still downloading after a
 * click (navigation.jsx swaps it in after a short grace, so a fast page never
 * flashes it), and as the Suspense fallback — the first page of a visit,
 * under the boot screen. It replaced a centred spinner in both.
 *
 * Four outlines, because the site has four page shapes and an outline of the
 * wrong one is its own small jolt when the page replaces it: a centred intro
 * over a grid of cards (most pages), a heading over stat cards (the account
 * pages), a sidebar beside an article (a docs page), and one card holding a
 * form (sign-in and sign-up). Sized from the real components' classes, so
 * the page lands on top of its outline rather than beside it.
 */

const Bar = ({ className = '' }) => <Skeleton className={`rounded ${className}`} />;

/** Lines of body text — the last one short, the way a paragraph ends. */
function Lines({ count = 3, className = '', last = 'w-2/3', height = 'h-3.5', gap = 'mt-3' }) {
  return (
    <div className={className}>
      {Array.from({ length: count }, (_, i) => (
        <Bar key={i} className={`${height} ${i ? gap : ''} ${i === count - 1 ? last : 'w-full'}`} />
      ))}
    </div>
  );
}

function IntroSkeleton() {
  return (
    <section className="section">
      <div className="container-x">
        <div className="page-intro flex flex-col items-center">
          <Skeleton className="h-[1.95rem] w-44 rounded-full" />
          <Bar className="mt-6 h-[clamp(2rem,4.4vw,3.5rem)] w-full max-w-xl rounded-xl" />
          <Bar className="mt-3 h-[clamp(2rem,4.4vw,3.5rem)] w-3/4 max-w-md rounded-xl" />
          <Lines count={2} className="mt-7 w-full max-w-xl" last="mx-auto w-4/5" height="h-4" />
        </div>
        <div className="mx-auto mt-12 grid max-w-5xl gap-5 md:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="card !p-7">
              <Skeleton className="h-12 w-12 rounded-[var(--radius-3)]" />
              <Bar className="mt-5 h-5 w-2/5" />
              <Lines count={3} className="mt-4" />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function AccountSkeleton() {
  return (
    <section className="section">
      <div className="container-x">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="w-full max-w-md">
            <Bar className="h-10 w-full rounded-xl" />
            <Bar className="mt-3 h-4 w-3/5" />
          </div>
          <div className="flex gap-3">
            <Skeleton className="h-11 w-28 rounded-[var(--radius-2)]" />
            <Skeleton className="h-11 w-24 rounded-[var(--radius-2)]" />
          </div>
        </div>
        <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="card flex items-center gap-4 !p-5">
              <Skeleton className="h-11 w-11 shrink-0 rounded-[var(--radius-3)]" />
              <div className="min-w-0 flex-1">
                <Bar className="h-3 w-16" />
                <Bar className="mt-2.5 h-5 w-24" />
              </div>
            </div>
          ))}
        </div>
        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          {[0, 1].map((i) => (
            <div key={i} className="card !p-6">
              <Bar className="h-5 w-1/3" />
              <Lines count={3} className="mt-5" />
              <Skeleton className="mt-6 h-11 w-36 rounded-[var(--radius-2)]" />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function DocsSkeleton() {
  return (
    <section className="section">
      <div className="container-x">
        <div className="grid gap-10 lg:grid-cols-[240px_1fr]">
          <div>
            <Bar className="h-3 w-16" />
            <div className="mt-4 flex flex-row flex-wrap gap-2 lg:flex-col">
              {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
                <Skeleton key={i} className="h-9 w-28 rounded-lg lg:w-full" />
              ))}
            </div>
          </div>
          <div className="min-w-0">
            <Bar className="h-9 w-2/3 max-w-sm rounded-xl" />
            <Lines count={2} className="mt-4 max-w-2xl" height="h-4" />
            <div className="card mt-8 !p-6 sm:!p-8">
              <Bar className="h-6 w-1/3" />
              <Lines count={4} className="mt-5" />
              <Bar className="mt-8 h-6 w-2/5" />
              <Lines count={3} className="mt-5" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function AuthSkeleton() {
  return (
    <section className="section auth-section flex min-h-[70vh] items-center">
      <div className="container-x">
        <div className="mx-auto w-full max-w-md">
          <div className="mb-5 flex justify-center">
            <Skeleton className="h-[1.95rem] w-36 rounded-full" />
          </div>
          <div className="card auth-card !p-8 sm:!p-9">
            <Bar className="h-8 w-3/5 rounded-lg" />
            <Bar className="mt-3 h-4 w-4/5" />
            <Skeleton className="mt-8 h-11 w-full rounded-[var(--radius-2)]" />
            {[0, 1].map((i) => (
              <div key={i} className="mt-5">
                <Bar className="h-3 w-20" />
                <Skeleton className="mt-2 h-11 w-full rounded-[var(--radius-2)]" />
              </div>
            ))}
            <Skeleton className="mt-7 h-11 w-full rounded-[var(--radius-2)]" />
          </div>
        </div>
      </div>
    </section>
  );
}

const ACCOUNT = /^\/(dashboard|billing|profile|activate)(\/|$)/;
const AUTH = /^\/(login|register)(\/|$)/;
const DOCS_PAGE = /^\/docs\/./;

/**
 * The outline of whichever page is on its way. The location is the one the
 * router is showing (<Routes location> provides it), so this is always the
 * page being gone TO.
 */
export default function RouteSkeleton() {
  const { pathname } = useLocation();
  const Shape = AUTH.test(pathname)
    ? AuthSkeleton
    : ACCOUNT.test(pathname)
      ? AccountSkeleton
      : DOCS_PAGE.test(pathname)
        ? DocsSkeleton
        : IntroSkeleton;
  return (
    <div role="status" aria-label="Loading the page" className="route-skeleton">
      <Shape />
    </div>
  );
}

export { AccountSkeleton };
