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
- How guardian consent is verified (#3)
- Who scans at check-in: reception scans the member, or the member scans a club code (#21)
