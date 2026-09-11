# Tervexa Changelog

Internal, technical record of what has shipped. This is for your own
reference (and mine, across sessions) — it is not linked from the app
itself. The public-facing summary of the same work lives at
`whats-new.html`, written for end users rather than as a dev log.

Format loosely follows [Keep a Changelog](https://keepachangelog.com/):
newest entry at the top, changes grouped as Added / Changed / Fixed.

This file was started retroactively on 2026-08-31 to consolidate
everything built up to and including v1.0.0. Going forward, add a new
`## [x.y.z] - YYYY-MM-DD` entry each time a meaningful batch of work
ships, rather than waiting for a big backlog.

---

## [1.2.0] - 2026-09-10

Role-scoped request types, a fifth request type for training, a full i18n
coverage audit, and billing/trial fixes surfaced by finally running the
billing test suites that had sat unrun since they were written.

### Added

- **Role-scoped request types + hybrid mode.** Each field-facing role now
  defaults to seeing/submitting only its own request types — technician:
  fault only; engineer: fault, installation, after-sales; field
  application specialist: application, after-sales. A per-account
  "hybrid mode" toggle (nav button) lifts the restriction everywhere at
  once for jobs that genuinely cross fields. Enforced server-side on both
  submission (403 with an `outsideScope` flag) and the fault log view, not
  just hidden in the UI. Supervisor/manager/admin remain unscoped, same as
  before.
- **Fifth request type: Training (field application specialist only).**
  Training now follows the same pattern as the other four types — its own
  `#request-type` option, two type-specific fields (training type, trainee
  audience), a tailored AI diagnosis prompt, fault-log filter/detail
  rendering, and full i18n across all 5 languages.
- `nav.hybridModeOff` / `nav.hybridModeOn` / `nav.hybridModeTooltip` keys
  added across en/fr/es/pt/sw.

### Changed

- **Free trial unified to 14 days for every new account, individual or
  company.** Company signups previously got a 30-day trial versus 14 days
  for individual signups; both now use the same trial length.
- **Language selector cleaned up to the 5 languages that actually have
  translations** (en/fr/es/pt/sw) — removed 8 dead options (German,
  Arabic, Chinese, Hindi, Russian, Japanese, Korean, Swedish) that
  silently fell back to English when picked, across all 17 real pages.
- Menu-toggle, language-selector and billing-cycle accessibility labels
  (`aria-label`/`title`) are now translated instead of hardcoded English —
  added `data-i18n-title` support to `applyTranslations()`.

### Fixed

- **Usage bars on the admin panel didn't turn red once usage hit 100% of
  the plan limit.** `renderUsageStat()` was setting an inline
  `background-color` that a CSS `background` gradient shorthand was
  silently painting over. Fixed by toggling a `.is-full` class instead, so
  the color override actually applies.
- Ran the two billing test suites (seat/report grace-then-block behavior,
  and provider webhook signature verification + plan upgrades) for the
  first time since they were written — both pass clean (34/34, 23/23);
  this is what surfaced the usage-bar bug above via the required
  screenshot review step.

### Notes for next time

- Real Paystack/Flutterwave/Stripe test-mode keys are still needed before
  billing goes live — everything above is verified against fake/no keys,
  since this environment has no real provider sandbox access.
- The trial countdown is currently visible only to a company's admin (on
  the Admin panel and Billing page) — a deliberate choice, not a gap:
  renewing the plan is the admin's job, not each field employee's.

---

## [1.1.0] - 2026-08-31

Real role-based permissions. The six roles on the signup form (technician,
field application specialist, engineer, site supervisor, maintenance
manager, administrator) previously only drew one line — technician/FAS
saw just their own reports, everyone else saw everything, with no other
differences. This release makes every role mean something specific,
enforced server-side on every route (never just hidden in the UI), plus
an admin panel to manage accounts and CSV/Excel/PDF export.

### Added

- **Tiered report permissions.**
  - Technician / field application specialist: submit reports, see and
    edit/resolve only their own (unchanged from before).
  - Engineer: submit reports, see the WHOLE fault log, but can only
    edit/resolve their own — same edit boundary as technician/FAS, wider
    view.
  - Site supervisor: cannot submit reports; sees and can edit/resolve
    every report.
  - Maintenance manager: same as supervisor, plus can permanently delete
    a report.
  - Administrator: same as manager, plus the only role with access to the
    new admin panel.
- **`DELETE /api/reports/:id`** — manager/admin only. Confirmed with a
  two-click "click again to confirm" button in the report detail panel
  (no native `window.confirm()` dialog) rather than a single-click delete.
- **Admin panel (`admin.html`)** — lists every account (name, email, role,
  active/deactivated), with a role dropdown and an activate/deactivate
  button per row. Admin-only: gated both by hiding the nav link for
  everyone else and by a server-side page redirect, same pattern as the
  existing login gate.
  - `GET /api/admin/users`, `PATCH /api/admin/users/:id` (role and/or
    active, admin-only).
  - Refuses a change that would leave zero active administrators — the
    one deliberate safety net in this release, since that would be an
    unrecoverable lockout (nobody left who could open the panel to undo
    it). An admin can still demote or deactivate themself as long as
    another active admin remains.
  - Deactivating an account takes effect immediately, not just on next
    login — `requireAuth` (and the page-gate, and `/api/me`) now checks
    the account is still active on every request, not only that a session
    exists, and clears the session if it isn't. Verified live: deactivated
    a logged-in account mid-session and confirmed its very next request
    was rejected, not just its next login attempt.
  - `users.active` column added to the database (default 1, so every
    existing account is unaffected).
- **Export: CSV, Excel and PDF** (`GET /api/reports/export?format=...`),
  plus a **Print** button (`window.print()` with a dedicated print
  stylesheet that hides the header/nav/toolbar/filters and leaves a clean
  table). All four restricted to engineer/supervisor/manager/admin — the
  same roles with full fault-log visibility — and all four honor whatever
  status/request-type filter is currently applied in the fault log table,
  so a download matches what's on screen. Added `exceljs` (xlsx) and
  `pdfkit` (pdf) as new dependencies; CSV needed no library.
- Nav link changes: "Report a fault" now hides for supervisor/manager/
  admin (who can't submit); a new "Admin" link shows only for
  administrators. Both are UI convenience only — the real enforcement is
  server-side.

### Fixed (found while building the above)

- **Three existing button classes silently ignored the `hidden`
  attribute.** `.btn-primary`, `.btn-secondary` and (the two new ones)
  `.log-toolbar`/`.btn-danger` each set `display` unconditionally, which
  — because an author stylesheet always wins over the browser's own
  default `[hidden] { display: none }` rule, even at equal selector
  specificity — meant `someElement.hidden = true` left the element fully
  visible instead of hiding it. Same root cause, one shared class:
  `.field-error` had the identical bug, which meant validation error
  messages across signup, login, password reset, fault report, and the
  resolution-notes form were never actually being hidden once shown
  (cosmetic where the text also gets cleared on success, a real stale
  message otherwise). Confirmed via computed-style checks before and
  after; fixed by adding an explicit `.the-class[hidden] { display: none
}` override for every affected class.
- The admin panel's 5-column table (name, email, role select, status,
  actions) didn't fit the standard 760px `.page-card` width and spilled
  past the card's edge. Added a `.page-card--wide` (880px) modifier and
  used it on `admin.html` only.

### Notes for next time

- Signup still lets anyone pick "Administrator" directly on the signup
  form — there's no gate on who can become the first/next admin. Not
  introduced by this release, but worth deciding on: an invite-only flow,
  or requiring an existing admin to promote someone via the new panel,
  rather than leaving it self-service.
- Export always reflects the full company fault log for the four roles
  allowed to use it — there's still no "site" or "team" scoping in the
  data model, same limitation noted in [1.0.0].

---

## [1.0.1] - 2026-08-31

Production-readiness fixes for running with multiple technicians logged in
at once over a longer period, prompted by a direct question about exactly
that.

### Added

- `sqlite-session-store.js` — a small persistent session store for
  `express-session`, backed by the same `tervexa.db` connection everything
  else uses (a new `sessions` table, swept for expired rows every 15
  minutes). Written in-house rather than pulling in a third-party package
  for this, since the surface area is small and it avoids taking on an
  unmaintained dependency.

### Changed

- **Sessions now survive a server restart.** Previously `express-session`
  used its default in-memory store — every logged-in session lived only in
  the running process's memory, so any restart (crash, redeploy, editing a
  file under `nodemon`) silently logged everyone out at once. Sessions are
  now rows in SQLite and persist across restarts. Verified live: logged in,
  confirmed the session row exists in the `sessions` table, killed and
  restarted the server process, and the same cookie still authenticated
  with no re-login.
- **AI endpoint rate limiting (`aiLimiter`, on `/api/diagnose` and
  `/api/chat`) now keys by logged-in user instead of IP address.** Several
  technicians diagnosing faults from the same office or site Wi-Fi used to
  share one IP-based bucket and could throttle each other out. Verified
  live: two different logged-in users hitting `/api/chat` from the same IP
  now get independent `RateLimit-Remaining` counters instead of sharing
  one.
- **Auth endpoint rate limiting (`authLimiter`, on `/api/signup`,
  `/api/login`, `/api/request-password-reset`, `/api/reset-password`) now
  keys by IP _plus_ the account identifier in the request** (email, or the
  reset token for `/api/reset-password`) instead of IP alone — there's no
  logged-in user yet at this point, so it can't key by userId the way
  `aiLimiter` does. This keeps the original protection (repeated attempts
  against one account from one place still get capped) while fixing the
  same shared-IP false-positive problem for login/signup. Verified live:
  repeated failed logins against one account still count down as before;
  a different account attempted from the same IP starts with a fresh
  count.
- **SQLite now runs in WAL mode** (`db.js`: `journal_mode = WAL`,
  `synchronous = NORMAL`, `busy_timeout = 5000`). The default journal mode
  locks the whole database for the duration of a write, including against
  readers — with several people using the app at once, that's what could
  occasionally produce a "database is locked" error. WAL mode lets reads
  and writes happen concurrently; `busy_timeout` makes the rare
  simultaneous-write case retry for up to 5 seconds instead of failing
  immediately. Verified live: `PRAGMA journal_mode` reports `wal` after
  startup.

### Fixed

- The `authLimiter` compound key (see above) crashed the server on start
  with `ERR_ERL_KEY_GEN_IPV6` — this project's `package.json` allows
  express-rate-limit anywhere in the 7.x range, and the installed copy
  turned out to be from a version (8.x is the same story) that requires
  any custom `keyGenerator` touching `req.ip` to run it through the
  library's own `ipKeyGenerator` helper first, so a raw IPv6 address can't
  be used as a rate-limit key directly (there are too many equivalent
  forms of one). Fixed by calling that helper when it's present and
  falling back to the raw IP when it isn't (older versions don't export
  it) — verified starting cleanly and behaving correctly against both an
  express-rate-limit 7.4.0 and an 8.7.0 install.

### Notes for next time

- No new npm dependency was needed for the session store — it's a plain
  file using the `better-sqlite3` connection already in the project.
- `SESSION_SECRET` in `.env` still defaults to `'change-this-in-production'`
  if unset — worth setting a real one before this goes further than local
  testing.

---

## [1.0.0] - 2026-08-31

Initial release. Core application, AI diagnosis, offline support,
multi-language coverage, and the full page set are in place.

### Added

- Account system: signup, login, "remember me", password reset via
  emailed link, session-based auth (`express-session`, `bcrypt`
  password hashing, `express-rate-limit` on auth endpoints).
- Fault reporting across four request types — fault diagnosis,
  installation & commissioning, after-sales support, and application &
  process support — with type-specific dynamic fields (severity, fault
  type, installation stage, warranty status, etc.) and photo upload.
- AI-powered diagnosis (Claude API) from a submitted report, plus a
  separate "Ask AI" chat page for quick questions that don't need a
  formal report.
- Fault log: every report tracked with status (open / in progress /
  resolved), root-cause categorisation, resolution notes, and
  filtering by status or request type.
- Offline fault logging — reports created without a connection are
  stored locally and synced automatically once connectivity returns.
- Spare parts links surfaced alongside diagnosis results.
- Role-based accounts: technician, field application specialist,
  engineer, site supervisor, maintenance manager, administrator.
- Multi-language UI: full translation (English, French, Spanish,
  Portuguese, Swahili) across every page via `js/i18n.js`, with
  account-level language preference (saved via
  `/api/preferred-language`) taking priority over the browser/local
  default. Additional languages are listed in the selector for future
  translation but currently fall back to English.
- Full page set: Home, About, Login, Signup, Reset password, New
  password, Report a fault, Fault log, Ask AI, Terms, Privacy,
  Security, Help, What's New.
- Visual design system: Poppins headings, a shared inline-SVG icon
  set, a low-opacity decorative background (blueprint grid + colour
  blooms) used behind card-based pages, and a reusable `.page-card`
  layout.
- Home and About pages redesigned with a hero/steps section, icon
  feature cards, role cards, roadmap chips, and a spare-parts grid.
- Login, Signup, Reset password and New password rebuilt as a
  split-screen layout (branding panel + form panel), stacking on
  mobile.
- Fault report, Fault log and Ask AI given the lighter design pass
  (decorated background, header icon, and — on Fault log — icon stat
  cards for the summary counts).
- Security and Help pages (new) and a What's New page (new), the
  latter linked from the version number in the footer.
- `WHATSAPP_SETUP.md` documenting the Meta Cloud API onboarding flow,
  for the WhatsApp integration (not yet live — see Known issues).

### Fixed

- `terms.html` and `privacy.html` were missing the `<script
src="js/i18n.js">` include. `main.js`'s `DOMContentLoaded` handler
  calls `initLanguage()`, which only exists in `i18n.js` — without it,
  that call threw and silently aborted the rest of the handler,
  including the code that wires up the mobile hamburger menu. Both
  pages were rebuilt with the standard header/footer/script pattern
  used by every other page.
- Footer's Security and Help labels were plain text on every page (no
  target existed). Now real links to `security.html` / `help.html`
  across all pages.
- `signup.html`'s footer was missing Privacy/Terms links that every
  other page had.

### Known issues / open threads

- WhatsApp Cloud API integration is documented but not connected with
  real production credentials — phone-number verification with Meta
  was last blocked on the verification code not arriving.
- The Jurisdiction section of `terms.html` still has a
  `[Your Company Name] Nig. Ltd` placeholder — needs the real
  registered company name filled in.
- Only 5 of the 13 languages listed in the language selector have full
  translations (en/fr/es/pt/sw); the rest currently fall back to
  English.
