# PadelLoyalty architecture

Soul Padel's member app: court bookings and the Soul points loyalty programme, on iOS, Android and the web, plus a staff back office, all from one Next.js codebase.

## Key decisions

| # | Decision | Date |
|---|----------|------|
| 1 | **Fully our own system.** No integration with Playtomic, Kuikma or other booking platforms. We build our own accounts and court booking system. | 2026-11-18 |
| 2 | **One TypeScript monorepo** for the web app and the API. | 2026-11-18 |
| 3 | **A payment provider handles card payments** (e.g. Stripe or Xendit, still to be chosen). We never store card numbers. | 2026-11-18 |
| 4 | **One Next.js app for members and staff**, packaged as iOS and Android apps with Capacitor (Option A). Chosen over Expo for simplicity: one front end, strong web. | 2026-11-18 |
| 5 | **API: Fastify + Drizzle ORM** (default chosen at setup; can be revisited before much code depends on it). | 2026-11-18 |
| 6 | **Points are called "Soul points" for now** (was "Almas"). The name is provisional: UI copy uses `POINTS_NAME` from `packages/shared`, and code identifiers stay neutral (`points`). | 2026-11-18 |
| 7 | **Own email + password accounts with bearer-token sessions** (#1): a short-lived access token and a rotating refresh token, no cookies. See [Authentication](#authentication). | 2026-11-18 |
| 8 | **Guardian consent by email link** (#3): under-18s nominate a parent or guardian, who confirms or declines through a single-use, expiring link. See [Guardian consent](#guardian-consent-under-18s). | 2026-11-18 |
| 9 | **Club setup by admins, enforced in the API** (#56): IANA time zone per club, money as integer minor units plus an ISO currency per club, pricing = slot lengths + standard (off-peak) prices + non-overlapping peak bands, priced by slot start time. See [Clubs and courts](#clubs-courts-and-prices). | 2026-11-24 |

## Stack

| Part | Technology | Notes |
|------|-----------|-------|
| Web app: members and staff | Next.js (App Router, TypeScript) | Member area at `/`, staff back office at `/admin`; access by role. Built as a **static export** (`output: "export"`): no Next.js server features, all data comes from the API. |
| iOS and Android apps | Capacitor, wrapping the static Next.js build | Native plugins for push, biometrics, camera/QR and secure storage. Native features matter for App Store review (a pure website wrapper can be rejected). |
| API | Node.js + TypeScript, Fastify | All business rules live here: bookings, points, tiers, rewards, referrals. Clients never compute balances. |
| Database | PostgreSQL, Drizzle ORM with migrations | Transactions for bookings and points. |
| Shared code | Turborepo + pnpm workspaces | Shared types and Zod validation schemas used by the web app and API. |
| Push notifications | Capacitor push (APNs / FCM), web push for browsers | |
| Payments | Payment provider (to be chosen) | Card data stays with the provider (tokenised). |

## Repo layout

```
apps/
  web/        Next.js app (member area + /admin), static export, Capacitor config
  api/        Fastify API
packages/
  shared/     Types, Zod schemas, constants
docs/
```

## Domain rules that shape the design

- **Soul points are an append-only ledger.** Every earn, redeem, expiry and staff adjustment is a ledger entry. The balance is the sum of the entries, never a value that is edited directly. This gives the audit trail (#34), points history (#9) and breakage reporting (#37).
- **No double counting.** One check-in for one booking can earn points only once per member. Redemption codes can be used once. Both are enforced with database constraints, not just application checks.
- **No double booking.** A court slot can hold only one booking, enforced in the database so that simultaneous requests can't both succeed.
- **Everyone on a booking earns.** Points are awarded per checked-in player on the booking (#8), not only to the booker.
- **Roles:** member, receptionist, club manager (scoped to one club), admin. Staff actions are logged.
- **Under-18 members** need a guardian consent record before their account is active (#3).

## Authentication

Issue #1. Contract: [`docs/api/auth.md`](api/auth.md); schemas: `packages/shared/src/auth.ts`.

**Accounts.** `users` has a `role` (`member` by default; `receptionist`, `club_manager`, `admin` for staff) and a `status` (`pending_verification` → `active`, or → `pending_consent` → `active` for under-18s, see [Guardian consent](#guardian-consent-under-18s)). Status is an enum rather than booleans so later states slot in. Unverified accounts can log in, so the app can show "verify your email" (and later "waiting for guardian consent"); features that need a fully active account check `status === "active"`. `password_hash` is nullable so an Apple/Google-only account can exist later.

**Passwords.** argon2id (OWASP baseline: 19 MiB, 2 iterations), 10 to 128 characters, no composition rules (NIST SP 800-63B). Login for an unknown email verifies a dummy hash so timing does not reveal registered emails.

**Sessions: why tokens, not cookies.** The web app runs on GitHub Pages and in Capacitor (`https://localhost`, `capacitor://localhost`), all on different origins from the API. A session cookie would be a third-party cookie there, which Safari blocks and Chrome is restricting, and Capacitor web views handle cross-site cookies inconsistently. So the API returns tokens in JSON and clients send `Authorization: Bearer`. The same flow works on web, iOS and Android, and needs no CSRF protection since nothing is sent automatically.

- **Access token:** opaque random value (256 bits, prefix `pla_`), valid **15 minutes**, kept **in memory only** by the client. Opaque rather than a JWT: every request already checks the session row, which makes logout and "log out everywhere" take effect at once and needs no signing-key management. The cost is one indexed lookup per request.
- **Refresh token:** opaque (`plr_`), valid **30 days, renewed on each use** (sliding). **Rotated** on every refresh; every replaced token's hash is kept (`rotated_refresh_tokens`), and if any of them is presented again (a sign of theft) the whole session is revoked. Stored in the **Keychain / Android Keystore** on native (`@aparajita/capacitor-secure-storage`) and in **localStorage** on the web.
- **Hashing:** the database stores only SHA-256 hashes of access, refresh and email-link tokens. They are high-entropy random values, so a fast hash is enough; a database leak yields nothing usable.
- One `sessions` row per device; logout revokes that row only. A password reset revokes all of them.
- The web client serialises refreshes across tabs with the Web Locks API, so two tabs never present the same refresh token (which would trip reuse detection).

**Web storage trade-off.** localStorage is readable by any script on the page, so an XSS bug could steal the refresh token. Mitigations: React escapes output and we render no user HTML, the refresh token alone is useless after rotation by the real client (reuse revokes the session), and sessions can be revoked server-side. If the API later shares a site with the web app (e.g. `app.soulpadel.com` and `api.soulpadel.com`), the web refresh token can move to an `httpOnly; Secure; SameSite=Strict` cookie without changing the native apps.

**Email links.** Verification (24 h) and password-reset (1 h) tokens are single-use, and issuing a new one invalidates older unused ones. Links carry the token in the URL fragment (`/verify-email/#token=…`), which browsers never send to the web host or in `Referer`; the page removes it from the address bar after use. Emails go through a `Mailer` interface (`apps/api/src/email/mailer.ts`): `ConsoleMailer` prints them in development, `CapturingMailer` records them in tests. A real provider implements the same interface.

**No account enumeration.** Sign-up, resend verification and password-reset request answer identically for registered and unknown emails (a registered address gets an "account already exists" email instead). Login gives one `invalid_credentials` error for both cases.

**Rate limiting.** In-memory fixed windows per IP and per email (login failures, sign-ups, email requests, link-token attempts); counted identically for unknown emails. Answers `429` with `Retry-After`. Set `TRUST_PROXY=true` behind a reverse proxy so the client IP is used.

**Adding Apple / Google sign-in later.** Add an identities table (`provider`, `subject`, `user_id`) and an endpoint that verifies the provider's ID token, finds or creates the user, then calls `AuthService.createSession`, the same function password login uses. Tokens, storage and refresh stay unchanged.

**Known limitations (auth).** Rate-limit counters are per process (move to Postgres or Redis before running several API instances). No breached-password check yet. Email links open the web app; universal / app links into the native apps come later. Native secure storage is wired up but has not been tested on a device yet.

## Guardian consent (under-18s)

Issue #3. Contract and edge cases: [`docs/api/consent.md`](api/consent.md); schemas: `packages/shared/src/consent.ts` and `age.ts`.

- **Date of birth for everyone** at sign-up. Age is computed on calendar dates (`ageOn`): it goes up on the birthday, a 29 February birthday counts from 1 March in other years, impossible and future dates are rejected. The threshold `ADULT_AGE = 18` is defined once in `packages/shared`. The API uses today's UTC date.
- **Order:** the member verifies their own email first; only then is the guardian emailed (so sign-up can't be used to email arbitrary addresses). Verification moves an under-18 account to `pending_consent` instead of `active` (`statusAfterEmailVerified`).
- **Consent link:** single-use, 7 days, token stored as a SHA-256 hash like the other email links; a resend or change of guardian invalidates older links. The guardian reviews (not consuming the link), then confirms (stating they are the parent or legal guardian) or declines.
- **Decline** keeps the account `pending_consent`; the member can nominate a different guardian but not ask the one who declined again.
- **Audit:** one `guardian_consent_requests` row per consent email: guardian email, member's date of birth, method (`email_link`), requested/expires/decided times, decision, IP and user agent of the decision, the guardian's statement, superseded time. The foreign key restricts deleting a member with consent records.
- **One check for member features:** `isAccountFullyActive(status)` (shared) and the `requireActiveAccount` preHandler (API, `403 account_not_active`). Booking and points routes must use it.
- **Not decided / not built:** the Safeguarding Policy review (placeholder text marks where the policy goes), a staff view of consent records, promotion on the 18th birthday, asking pre-#3 accounts for a date of birth, a club time zone for "today".

## Clubs, courts and prices

Issue #56. Contract: [`docs/api/clubs.md`](api/clubs.md); schemas: `packages/shared/src/clubs.ts`, `zoned-time.ts`, `money.ts`.

- **Access.** The web app is a static export, so every rule is enforced by the API. `/admin/clubs*` routes run `requireAuth`, then `ClubAccessPolicy` (`apps/api/src/clubs/access.ts`): `401` without a token, `403 forbidden` for roles other than admin, `403 account_not_active` for an unverified admin. Club-scoped routes call `canManageClub(user, clubId)`, so club managers (#39) need only a club assignment and a policy change. The `/admin` pages hide what the role can't use, with a clear "No access" message. The first admin is created with `pnpm --filter @padelloyalty/api admin:create <email>` (verified accounts only).
- **Time zones.** Each club has an IANA zone. Opening hours, price bands and block times are wall-clock times there; block instants are stored in UTC (`timestamptz`) and converted with `Intl` only (`fromLocalDateTime`, `toLocalDateTime`). Times skipped when the clocks go forward are rejected; repeated times use the earlier instant.
- **Money.** Integer minor units (`amountMinor`) plus the club's ISO 4217 `currency` (default GBP). Prices are parsed from decimal text without floats. A club's currency can't change while it has prices.
- **Pricing.** A JSON document on the club: 1 to 4 slot lengths, one standard price per length (the off-peak price and the fallback for any time no band covers), and up to 20 non-overlapping peak bands with their own prices. A slot is priced by its start time (`priceForSlot`). Booking (#23) should store the price it charged, so later price changes don't rewrite history.
- **History.** Clubs and courts are deactivated, never deleted (foreign keys restrict it). Cancelling a block sets `cancelled_at`. Blocks record who created and cancelled them.
- **For booking (#23).** Public reads: `GET /clubs`, `GET /clubs/:id` (active courts and pricing), `GET /clubs/:id/blocks`. In the booking transaction, call `ClubService.findBlockingBlocks(courtId, startsAt, endsAt, tx)` and `isWithinOpeningHours`.

## Testing

- Unit and integration tests: Vitest or Jest
- API tests against a real Postgres (e.g. Testcontainers)
- Web end-to-end: Playwright
- Mobile: the same Playwright suite at mobile viewport; device testing of native plugins later

## Open decisions

Tracked on GitHub with the `needs-decision` label. The main ones are:

- Payment provider (#58, #43)
- Cancellation and refund policy (#59)
- What "Free Play for Life" covers (#16)
- Players on a booking who have no account (#8, #57)
- Who scans at check-in: reception scans the member, or the member scans a club code (#21)
