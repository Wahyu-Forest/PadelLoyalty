# PadelLoyalty architecture

Soul Padel's member app: court bookings and the Almas loyalty programme, on iOS, Android and the web, plus a staff back office.

## Key decisions

| # | Decision | Date |
|---|----------|------|
| 1 | **Fully our own system.** No integration with Playtomic, Kuikma or other booking platforms. We build our own accounts and court booking system. | 2026-11-18 |
| 2 | **One TypeScript monorepo** for the member app, the back office and the API. | 2026-11-18 |
| 3 | **A payment provider handles card payments** (e.g. Stripe or Xendit, still to be chosen). We never store card numbers. | 2026-11-18 |

## Stack

| Part | Technology | Notes |
|------|-----------|-------|
| Member app (iOS, Android, web) | Expo (React Native) + Expo Router | One codebase, built for the App Store, Google Play and the browser. EAS for builds and over-the-air updates. |
| Staff back office | Next.js | Reception, club managers and admins. Desktop-first. |
| API | Node.js + TypeScript (NestJS or Fastify, to be confirmed) | All business rules live here: bookings, points, tiers, rewards, referrals. Clients never compute balances. |
| Database | PostgreSQL | Transactions for bookings and points. |
| Shared code | Turborepo + pnpm workspaces | Shared types and validation schemas (e.g. Zod) used by the app, back office and API. |
| Push notifications | Expo Notifications (APNs / FCM) | |
| Payments | Payment provider (to be chosen) | Card data stays with the provider (tokenised). |

## Proposed repo layout

```
apps/
  mobile/     Expo app (iOS, Android, web)
  admin/      Next.js back office
  api/        Backend API
packages/
  shared/     Types, validation schemas, constants
  ui/         Shared UI components (where useful)
docs/
```

## Domain rules that shape the design

- **Almas are an append-only ledger.** Every earn, redeem, expiry and staff adjustment is a ledger entry. The balance is the sum of the entries, never a value that is edited directly. This gives the audit trail (#34), points history (#9) and breakage reporting (#37).
- **No double counting.** One check-in for one booking can earn points only once per member. Redemption codes can be used once. Both are enforced with database constraints, not just application checks.
- **No double booking.** A court slot can hold only one booking, enforced in the database so that simultaneous requests can't both succeed.
- **Everyone on a booking earns.** Points are awarded per checked-in player on the booking (#8), not only to the booker.
- **Roles:** member, receptionist, club manager (scoped to one club), admin. Staff actions are logged.
- **Under-18 members** need a guardian consent record before their account is active (#3).

## Testing

- Unit and integration tests: Vitest or Jest
- API tests against a real Postgres (e.g. Testcontainers)
- Web end-to-end: Playwright
- Mobile end-to-end: Maestro

## Open decisions

Tracked on GitHub with the `needs-decision` label. The main ones are:

- Payment provider (#58, #43)
- Cancellation and refund policy (#59)
- What "Free Play for Life" covers (#16)
- Players on a booking who have no account (#8, #57)
- How guardian consent is verified (#3)
- Who scans at check-in: reception scans the member, or the member scans a club code (#21)
- NestJS vs Fastify for the API
