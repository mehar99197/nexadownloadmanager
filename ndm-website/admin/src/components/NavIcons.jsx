/**
 * The sidebar's marks — one line family (24-unit grid, 1.75 stroke, round
 * caps) so every screen's icon reads as part of one set, instead of the
 * unrelated Unicode symbols they replace. Shapes follow Lucide (ISC licence),
 * drawn inline so the panel takes no icon dependency.
 *
 * Each is decorative: the link it sits in carries the name.
 */
function Glyph({ children }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
      {children}
    </svg>
  );
}

// Dashboard: the overview — tiles of different weight.
export const DashboardIcon = () => (
  <Glyph>
    <rect width="7" height="9" x="3" y="3" rx="1.5" />
    <rect width="7" height="5" x="14" y="3" rx="1.5" />
    <rect width="7" height="9" x="14" y="12" rx="1.5" />
    <rect width="7" height="5" x="3" y="16" rx="1.5" />
  </Glyph>
);

// Users: people, more than one.
export const UsersIcon = () => (
  <Glyph>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </Glyph>
);

// Subscriptions: a card that renews — a card with a repeat mark on it.
export const SubscriptionsIcon = () => (
  <Glyph>
    <path d="M22 10V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h7" />
    <path d="M2 10h20" />
    <path d="M21 16a3.5 3.5 0 0 0-6.2-2.2L14 15" />
    <path d="M14 12.5V15h2.5" />
    <path d="M14.5 19.5a3.5 3.5 0 0 0 6.2-1.3" />
  </Glyph>
);

// Reviews: a rating said in words — a speech bubble holding a star.
export const ReviewsIcon = () => (
  <Glyph>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    <path d="m12 6.5 1.1 2.3 2.5.35-1.8 1.75.43 2.5L12 12.2l-2.23 1.2.43-2.5-1.8-1.75 2.5-.35z" />
  </Glyph>
);

// Contact inbox: the tray messages land in.
export const InboxIcon = () => (
  <Glyph>
    <path d="M22 12h-6l-2 3h-4l-2-3H2" />
    <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
  </Glyph>
);

// Releases: a shipped build — a package.
export const ReleasesIcon = () => (
  <Glyph>
    <path d="m7.5 4.27 9 5.15" />
    <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
    <path d="m3.3 7 8.7 5 8.7-5" />
    <path d="M12 22V12" />
  </Glyph>
);

// Ads: a promotion — a megaphone.
export const AdsIcon = () => (
  <Glyph>
    <path d="m3 11 18-5v12L3 14v-3z" />
    <path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" />
  </Glyph>
);

// Activity log: a live pulse of what is happening.
export const ActivityIcon = () => (
  <Glyph>
    <path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" />
  </Glyph>
);

// Security: a shield that has been checked.
export const SecurityIcon = () => (
  <Glyph>
    <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
    <path d="m9 12 2 2 4-4" />
  </Glyph>
);

// Admins: a person with a key — who may administer.
export const AdminsIcon = () => (
  <Glyph>
    <circle cx="9" cy="7" r="4" />
    <path d="M10.5 15H6a4 4 0 0 0-4 4v2" />
    <circle cx="16.5" cy="17.5" r="2.5" />
    <path d="m18.3 15.7 3.7-3.7" />
    <path d="m20.5 13.5 1.5 1.5" />
  </Glyph>
);

// Audit trail: the record, read back in time.
export const AuditIcon = () => (
  <Glyph>
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
    <path d="M12 7v5l4 2" />
  </Glyph>
);

// Danger zone: a warning.
export const DangerIcon = () => (
  <Glyph>
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
  </Glyph>
);

// Logout: out through the door.
export const LogoutIcon = () => (
  <Glyph>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="m16 17 5-5-5-5" />
    <path d="M21 12H9" />
  </Glyph>
);
