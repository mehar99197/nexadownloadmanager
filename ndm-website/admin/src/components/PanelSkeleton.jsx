import Skeleton, { BAR_OUTLINE } from './Skeleton.jsx';
import { IS_ROOT } from '../realm.js';
import { readRail } from '../sidebarPreference.js';

/**
 * The control panel before the session is known — what used to be the word
 * "Loading…" alone in the middle of an empty screen, which then cut to the
 * whole panel at once.
 *
 * It is the panel's own layout, drawn in outline: the sidebar with its
 * links, the topbar, and a screen of the dashboard's shape, because that is
 * where a sign-in lands. The real panel replaces it inside a dissolve
 * (AdminAuthContext), so what was a bar becomes a word in place. The sidebar
 * is drawn folded if that is how it was left (sidebarPreference.js), so the
 * panel does not arrive wide and then fold.
 *
 * `.panel-boot` holds it invisible for its first moments and then fades it
 * in (index.css): a visit with no session is sent to the sign-in screen
 * within a frame or two, and must not flash a panel it was never going to
 * see.
 */
export default function PanelSkeleton() {
  const links = IS_ROOT ? 12 : 9;
  const rail = readRail();
  return (
    <div className="panel-boot flex min-h-screen bg-admin-bg" role="status" aria-label="Loading the control panel">
      <aside className={`hidden shrink-0 flex-col border-r border-admin-border bg-admin-sidebar md:flex ${rail ? 'w-16' : 'w-60'}`}>
        <div className="flex h-16 items-center gap-2 border-b border-admin-border px-3.5">
          <Skeleton className="h-9 w-9 shrink-0 rounded-xl" />
          {!rail && (
            <div>
              <Skeleton className="h-3.5 w-28 rounded" />
              <Skeleton className="mt-1.5 h-3 w-20 rounded" />
            </div>
          )}
        </div>
        <div className="flex-1 space-y-1 px-3 py-4">
          {Array.from({ length: links }, (_, i) => (
            <div key={i} className="flex h-10 items-center gap-3 px-3">
              <Skeleton className="h-3.5 w-4 shrink-0 rounded" />
              {!rail && <Skeleton className={`h-3.5 rounded ${i % 3 === 1 ? 'w-28' : i % 3 === 2 ? 'w-20' : 'w-24'}`} />}
            </div>
          ))}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-16 items-center justify-between border-b border-admin-border bg-admin-surface/80 px-6">
          <div className="flex items-center gap-3">
            {/* The navigation button: the drawer's on a phone, the fold's on
                a desktop. */}
            <Skeleton className="h-11 w-11 rounded-lg" />
            <div>
              <Skeleton className="h-3 w-36 rounded" />
              <Skeleton className="mt-1.5 h-3.5 w-44 rounded" />
            </div>
          </div>
          <Skeleton className="h-3 w-24 rounded" />
        </div>

        <div className="flex-1 space-y-6 p-6">
          {/* The dashboard's heading block, line box by line box: the eyebrow,
              the title, two lines of text, and the actions beside them. */}
          <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
            <div className="w-full max-w-3xl">
              <div className="flex h-4 items-center"><Skeleton className="h-3 w-32 rounded" /></div>
              <div className="mt-2 flex h-9 items-center"><Skeleton className="h-8 w-60 max-w-full rounded-lg" /></div>
              <div className="mt-2 flex h-6 items-center"><Skeleton className="h-3.5 w-full rounded" /></div>
              <div className="flex h-6 items-center"><Skeleton className="h-3.5 w-1/3 rounded" /></div>
            </div>
            <div className="flex flex-wrap gap-2 xl:w-64">
              <Skeleton className="h-[38px] w-[122px] rounded-lg" />
              <Skeleton className="h-[38px] w-[126px] rounded-lg" />
              <Skeleton className="h-[38px] w-[113px] rounded-lg" />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="stat-card">
                <Skeleton className="h-4 w-28 rounded" />
                <Skeleton className="mt-3 h-8 w-20 rounded-lg" />
                <Skeleton className="mt-4 h-3 w-32 rounded" />
              </div>
            ))}
          </div>
          <div className="admin-card flex flex-wrap items-center gap-3 !p-4">
            <Skeleton className="h-3 w-24 rounded" />
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-7 w-32 rounded-full" />
            ))}
          </div>
          <div className="grid gap-6 xl:grid-cols-2">
            {[14, 6].map((count, card) => (
              <div key={card} className="admin-card">
                <Skeleton className="h-5 w-32 rounded" />
                <Skeleton className="mt-2 h-3 w-56 max-w-full rounded" />
                <div className="mt-6 flex h-[220px] items-end gap-2">
                  {BAR_OUTLINE.slice(0, count).map((h, i) => (
                    <div key={i} className="flex h-full min-w-0 flex-1 items-end justify-center">
                      <Skeleton className="w-full max-w-16 rounded-t-md" style={{ height: `${h}%` }} />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <span className="sr-only">Loading the control panel…</span>
    </div>
  );
}
