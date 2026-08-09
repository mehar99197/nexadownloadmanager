# NDM Admin — conventions for page agents

This is a **separate** Vite + React 18 app from the public frontend. It is served
under **`/admin`** in production. Page agents implement the page stubs in
`src/pages/`. The scaffold (api client, auth context, layout, components,
routing) is already built — **do not** modify shared files; only fill in pages.

---

## Stack

- Vite 6 + React 18, JavaScript, ESM (`type: module`).
- `react-router-dom` v6, `axios`.
- Tailwind CSS v4 via `@tailwindcss/vite` (config-less; theme tokens live in
  `src/index.css` under `@theme`).
- Dev server on **:5174**, proxies `/api` → `http://localhost:3001`.
- `base: '/admin/'`; router `basename="/admin"` (set in `main.jsx`).

---

## Import paths

```js
import api, { unwrap } from '../api/client.js';        // axios instance + envelope unwrapper
import { useAdminAuth } from '../context/AdminAuthContext.jsx';

// Components
import AdminLayout from '../components/AdminLayout.jsx';
import StatCard from '../components/StatCard.jsx';
import DataTable from '../components/DataTable.jsx';
import Pagination from '../components/Pagination.jsx';
import Badge from '../components/Badge.jsx';        // also exports { STATUS_TONE }
import Button from '../components/Button.jsx';
import Input from '../components/Input.jsx';
import Modal from '../components/Modal.jsx';
import BarChart from '../components/BarChart.jsx';
```

(Pages live in `src/pages/`, so components are one level up: `../components/...`.)

---

## API + response envelope

The backend wraps every response (except a couple of non-admin endpoints) in
`{ ok, data }` on success or `{ ok:false, error:{ code, message, details? } }`.

- **`api`** — axios instance. `baseURL = VITE_API_URL || '/api'`. Automatically
  attaches `Authorization: Bearer <ndm_admin_token>` from localStorage. On HTTP
  **401** it clears the stored token and rejects.
- **`unwrap(promise)`** — awaits an axios call, validates the envelope, and
  returns `data` (throws an `Error` with `.code`/`.details` on `ok:false`).

```js
// GET
const stats = await unwrap(api.get('/admin/stats'));

// list with query params
const data = await unwrap(api.get('/admin/users', { params: { page, limit } }));

// mutate
await unwrap(api.put(`/admin/users/${id}`, { banned: true }));
await unwrap(api.post('/admin/releases', payload));
```

Wrap calls in `try/catch`; show `err.message` to the user.

---

## Auth — `useAdminAuth()`

```js
const { admin, loading, isAuthenticated, login, logout } = useAdminAuth();
```

- `login(email, password)` → `POST /api/admin/login`, stores `data.token` in
  localStorage key **`ndm_admin_token`**, sets `isAuthenticated`. Throws on failure.
- `logout()` → clears the token.
- `isAuthenticated` is derived purely from **token presence** — there is **no**
  `/api/admin/me` endpoint, so do not try to fetch an admin profile. `admin` is a
  minimal `{ authenticated: true }` (or `null`).

The admin token is **separate** from the user token (different localStorage key,
different secret server-side).

---

## Routing & basename

Router `basename="/admin"` means paths in code are **relative to `/admin`**
(write `/dashboard`, not `/admin/dashboard`). Routes (in `src/App.jsx`):

| Path | Page | Protected |
|------|------|-----------|
| `/login` | `AdminLogin` | no |
| `/` | → redirect to `/dashboard` | yes |
| `/dashboard` | `AdminDashboard` | yes |
| `/users` | `Users` | yes |
| `/subscriptions` | `Subscriptions` | yes |
| `/reviews` | `Reviews` | yes |
| `/releases` | `Releases` | yes |
| `*` | `NotFound` | — |

Protected routes are wrapped by `ProtectedAdminRoute` (redirects to `/login`
without a token) and rendered inside `AdminLayout` via `<Outlet/>`. **Pages do
not render the sidebar themselves** — the layout supplies it. The only exception
is `AdminLogin`, which renders standalone (no layout) and is full-screen centered.

---

## Component props (quick reference)

- **`<StatCard label value hint? icon? accent? />`** — metric tile.
- **`<DataTable columns rows rowKey? loading? emptyMessage? onRowClick? />`**
  `columns: [{ key, header, render?(row, i), className? }]`. `render` defaults to
  `row[key]`. `rowKey` defaults to `row.id ?? row._id ?? index`.
- **`<Pagination page totalPages onPageChange />`** — renders nothing if
  `totalPages <= 1`. `page` is 1-based.
- **`<Badge tone? status? >children?</Badge>`** — tone ∈
  `default|success|warning|danger|info`. If `status` is given (e.g. `active`,
  `pending`, `cancelled`), tone is auto-picked via `STATUS_TONE`, and the status
  text is rendered when no children.
- **`<Button variant? size? ...native />`** — variant ∈
  `primary|secondary|danger|ghost`; size ∈ `sm|md`.
- **`<Input label? error? ...native />`** — labeled input; uses `name` as id.
- **`<Modal open onClose title? footer? size? >body</Modal>`** — closes on
  backdrop click + Escape. size ∈ `sm|md|lg`.
- **`<BarChart data height? valueFormatter? barClassName? />`** — pure CSS/SVG
  bars (**no chart library**). `data: [{ label, value }]`.

---

## Theme / styling

Tailwind utilities use the custom `admin-*` color tokens defined in
`src/index.css`:
`admin-bg`, `admin-surface`, `admin-surface-2`, `admin-border`, `admin-sidebar`,
`admin-text`, `admin-muted`, `admin-faint`, `admin-accent`, `admin-accent-hover`,
`admin-success`, `admin-warning`, `admin-danger`, `admin-info`.

Reusable component classes: `.admin-card`, `.stat-card`, `.admin-table`,
`.nav-link` / `.nav-link-active`, `.admin-input`, `.admin-label`.

---

## Admin endpoints (from CONTRACT.md §6)

All require the admin token except `POST /api/admin/login`.

| Method | Path | Notes |
|--------|------|-------|
| POST | `/api/admin/login` | open; returns `{ token }` in `data` |
| GET | `/api/admin/stats` | dashboard metrics |
| GET | `/api/admin/users` | query: `page`, `limit` (+ filters) |
| PUT | `/api/admin/users/:id` | body: `{ banned?, role?, plan? }` |
| GET | `/api/admin/subscriptions` | query: `page`, `limit` |
| GET | `/api/admin/reviews/pending` | pending reviews |
| PUT | `/api/admin/reviews/:id` | body: `{ status }` |
| GET | `/api/admin/releases` | all releases |
| POST | `/api/admin/releases` | create |
| PUT | `/api/admin/releases/:id` | update / set latest |

---

## Page-file contract (rules for page agents)

1. Each page lives at `src/pages/<Name>.jsx` and `export default` a component.
   Replace the stub body; **keep the same default export name** so `App.jsx`
   imports still resolve. Do **not** edit `App.jsx`, routing, or the basename.
2. Fetch through `api` + `unwrap`; never read the token or call axios directly
   for auth. Use `useAdminAuth()` for login/logout/auth state.
3. Reuse the shared components above — do not hand-roll tables, modals, buttons,
   inputs, badges, pagination, or charts. **No chart library** — use `BarChart`.
4. Do **not** modify `src/api/client.js`, `src/context/AdminAuthContext.jsx`,
   `src/components/*`, `src/index.css`, `vite.config.js`, or `package.json`.
   Do **not** run `npm install` (deps are already installed).
5. Handle loading and error states (`try/catch`, show `err.message`). Respect the
   `{ ok, data }` envelope — `unwrap` already does this for you.
6. Paths are relative to `/admin` (router basename). Use `/dashboard`, not
   `/admin/dashboard`, in `<Link>`/`navigate`.
