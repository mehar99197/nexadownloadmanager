# FRONTEND CONVENTIONS — NDM website (public + user portal)

Single source of truth for **page agents**. The scaffold (config, router, API
client, auth context, shared components) is already built and **owned by the
foundation**. Page agents only fill in their own page file body.

Stack: **Vite + React 18 + react-router-dom v6 + axios + Tailwind CSS v4**
(via `@tailwindcss/vite`). JavaScript, ESM. Dev server on `:5173`, proxies
`/api` → `http://localhost:3001`.

---

## 1. The page-file contract (READ THIS)

1. Your page lives at `src/pages/<PageName>.jsx` and must
   `export default function <PageName>() { ... }` (named exactly like the file).
2. **Only edit your own page file.** Never touch `App.jsx`, `main.jsx`,
   `src/api/*`, `src/context/*`, `index.css`, `vite.config.js`, `package.json`,
   or the shared `src/components/*`. If you think a shared component needs a new
   prop, flag it — don't edit it.
3. Reuse the shared components and theme classes below. Don't reinvent buttons,
   inputs, cards, spinners, or toasts.
4. Routes are already wired in `App.jsx`:
   - Public: `/`, `/download`, `/pricing`, `/reviews`, `/login`, `/register`,
     `/verify-email`, `/forgot-password`, `/reset-password`.
   - Protected (wrapped in `<ProtectedRoute>`): `/dashboard`, `/billing`,
     `/profile`. Inside these you can assume `useAuth().user` is non-null.
   - `*` → `NotFound`.
5. Every page renders inside the layout (`Navbar` + your content + `Footer`).
   Wrap your content in `<Section>` for consistent spacing.

---

## 2. Imports — exact paths

From a file in `src/pages/`:

```js
import api, { unwrap } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/Toast';

import Section from '../components/Section';
import Card from '../components/Card';
import Button from '../components/Button';
import Input from '../components/Input';
import Spinner from '../components/Spinner';
import StarRating from '../components/StarRating';
```

(`useNavigate`, `Link`, `useSearchParams`, etc. come from `react-router-dom`.)

---

## 3. API + the response envelope

`api` is a preconfigured axios instance:

- `baseURL = import.meta.env.VITE_API_URL || '/api'`.
- A request interceptor adds `Authorization: Bearer <token>` from the in-memory
  access token automatically — **do not** set auth headers yourself. The refresh
  token is an httpOnly cookie; a page reload rehydrates the access token through
  `/auth/refresh`.
- `withCredentials: true` (so the httpOnly `ndm_refresh` cookie flows for refresh).
- On a `401` the interceptor clears the stored token and **rejects** (it does NOT
  redirect). Handle the rejection in your page (e.g. show a toast or redirect).

**Envelope:** every JSON response is `{ ok: true, data }` on success or
`{ ok: false, error: { code, message, details? } }` on error. Use the helper:

```js
const res = await api.get('/reviews', { params: { page: 1 } });
const data = unwrap(res); // === res.data.data
```

Errors throw (axios rejects on non-2xx). Read the message from
`err.response?.data?.error?.message`:

```js
try {
  const data = unwrap(await api.post('/subscription/checkout', body));
  window.location.href = data.url;
} catch (err) {
  toast.error(err.response?.data?.error?.message || 'Something went wrong');
}
```

> **The ONE exception** to the envelope is `POST /api/license/validate`, which
> returns a literal `{ valid, ... }` shape for the C++ app. **The website never
> calls it** — ignore it. Do not use `unwrap` on it.

### Endpoints the website uses (from CONTRACT.md)

Auth (public): `POST /auth/register`, `POST /auth/login`,
`POST /auth/verify-email`, `POST /auth/forgot-password`,
`POST /auth/reset-password`, `POST /auth/logout`.
(Login/register/logout are handled for you via `useAuth` — prefer those.)

User portal (`requireAuth`, token auto-attached):
`GET /user/me`, `PUT /user/profile`, `GET /user/license`, `GET /user/billing`.

Subscriptions: `GET /subscription/plans` (public), `POST /subscription/checkout`,
`POST /subscription/cancel`, `GET /subscription/status`.

Reviews: `GET /reviews` (public, paginated, `?page&limit&rating`),
`POST /reviews` (auth, body `{ rating, comment }`).

Releases: `GET /releases/latest` (public).

Misc public: `GET /health`, `GET /stats`.

Payloads/fields are documented in `../CONTRACT.md` §6 — read it before building a
form so field names match (e.g. checkout body `{ plan, billingCycle }`).

---

## 4. Auth — `useAuth()`

```js
const { user, loading, isAuthenticated, login, register, logout, refreshMe } =
  useAuth();
```

- `user` — current user (with `.subscription`), or `null`.
- `loading` — true only during the initial session hydrate on app mount.
- `isAuthenticated` — `!!user`.
- `login(email, password)` — POSTs `/auth/login`, stores the token, then loads
  `/user/me`. Returns the user; throws on failure.
- `register({ name, email, password })` — POSTs `/auth/register`; returns the
  envelope data. Does **not** auto-login (verify-email flow may be required).
- `logout()` — POSTs `/auth/logout` (errors ignored) and clears local state.
- `refreshMe()` — re-fetches `/user/me`; call after `PUT /user/profile` to refresh.

Login pattern with `?next=` redirect:

```js
const [params] = useSearchParams();
const next = params.get('next') || '/dashboard';
await login(email, password);
navigate(next, { replace: true });
```

---

## 5. Toasts — `useToast()`

```js
const toast = useToast();
toast.success('Saved');
toast.error('Could not save');
toast.info('Heads up');
// toast.show(message, type='info', durationMs=4000)
```

A `<ToastProvider>` already wraps the app (in `App.jsx`); just consume the hook.

---

## 6. Shared components + props

| Component | Key props | Notes |
|-----------|-----------|-------|
| `Section` | `id`, `className`, `innerClassName`, `full` | Page wrapper: vertical rhythm + `.container-x`. `full` drops the inner container for full-bleed heroes. |
| `Card` | `as` (default `div`), `className` | Themed surface. |
| `Button` | `variant` (`'primary'`\|`'ghost'`), `to`, `href`, `type`, `onClick`, `disabled` | Renders `<Link>` when `to`, `<a>` when `href`, else `<button>`. |
| `Input` | `label`, `name`, `error`, `hint`, plus all native input props; `forwardRef` | Labelled, themed text field with error/hint slots. |
| `Spinner` | `size` (px), `center` (full-area), `className` | `center` for full-page loading. |
| `StarRating` | `value` (can be fractional), `onChange` (interactive), `max=5`, `size`, `readOnly` | Pass `onChange` for interactive picking; omit for display. |
| `Navbar` / `Footer` | — | Rendered by the layout; don't import into pages. |
| `ProtectedRoute` | `children` | Used in `App.jsx` only. |

---

## 7. Tailwind v4 theme tokens + reusable classes

Defined in `src/index.css` via an `@theme` block. Use these so pages stay
consistent. (Tailwind v4 auto-generates utilities from the tokens, e.g.
`bg-brand-500`, `text-accent-400`, `from-brand-500`.)

**Color tokens**
- Brand (indigo): `brand-50 … brand-900` (primary `brand-500` / `brand-600`).
- Accent (violet): `accent-400`, `accent-500`, `accent-600` — gradient partner.
- Dark surfaces: `surface-0` (page bg), `surface-1` (cards/footer), `surface-2`
  (inputs/hover), `surface-3`, `surface-border` (borders).
- `muted` for secondary text. For body text the default is light zinc.

Use surface tokens via CSS vars when you need them directly, e.g.
`bg-[var(--color-surface-2)]`, `border-[var(--color-surface-border)]`.

**The ink ramp — pick a tone, don't pick a hex.** Hand-written CSS uses
`--color-ink-1` (strongest body text) through `--color-ink-4` (faintest meta),
plus `--color-ink-brand` for brand-coloured text on the light theme. All of
them flip with the theme, which is the point: the one-off hexes they replaced
were dark-theme values that stayed dark on white — `.page-intro p` sat at
2.4:1 there. In markup prefer the Tailwind utilities that already match the
ramp (`text-white`, `text-slate-300/400/500`, `text-brand-300`) over a new
shade. `.hero-console` deliberately re-pins the dark ramp in both themes: it
is a picture of the desktop app, which is dark.

**The radius scale.** `--radius-1` (0.5rem) → `--radius-5` (1.75rem), plus
`--radius-pill`. Steps 1–3 are exactly Tailwind's `rounded-lg` / `rounded-xl` /
`rounded-2xl` and `--radius-pill` is exactly `rounded-full`, so utility markup
and hand-written CSS land on the same computed values. Don't add a sixth step
or an arbitrary `rounded-[…]`; reach for the nearest existing one.

Keep type at **12px (`text-xs` / `0.75rem`) or larger** — that is the floor for
body copy, and it applies to badges and captions too. Reserve `uppercase` for
genuinely short labels; a phrase set in caps is slower to read than one in
sentence case.

**Reusable component classes** (in `index.css`)
- `.container-x` — centered max-width horizontal container.
- `.section` — standard vertical section padding (`Section` applies it).
- `.card` — themed card surface (or use `<Card>`).
- `.btn`, `.btn-primary`, `.btn-ghost`, `.btn-soft` — buttons (or use
  `<Button>`, which covers primary/ghost). Three weights on purpose: one
  `.btn-primary` per view is the page's call to action, `.btn-soft` is the
  brand-tinted step down used by the persistent navbar, `.btn-ghost` is
  neutral. Two gradient buttons on one screen compete and neither wins.
- `.text-gradient` — indigo→violet gradient text for headings/brand accents.

Element resets (`a`, `button`, `input`, `textarea`) live in `@layer base`.
Keep them there — unlayered rules outrank *every* `@layer components` class,
and an unlayered `a { color: inherit }` silently beat `.btn-primary`'s own
colour on every button rendered as a link.

Prefer the components; drop to raw classes only for layout/one-offs.

---

## 8. Conventions recap

- Functional components + hooks only; default export named like the file.
- Use `async/await` with try/catch around API calls; surface errors via `toast`.
- Show `<Spinner />` while loading data; never leave a blank screen.
- Keep pages self-contained; factor page-local bits into the same file or a
  co-located component — don't add to `src/components/` (shared, foundation-owned).
- Don't hard-code the API base URL or tokens; the client handles both.
```
