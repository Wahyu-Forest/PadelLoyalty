# Points API and ledger (issue #6)

The member's points balance, and the points ledger that every later points feature writes to:
earn on check-in (#7, #8), history (#9), expiry (#10), redeem (#15), staff adjustments (#34) and
reporting (#37). The Zod schemas and constants in
[`packages/shared/src/points.ts`](../../packages/shared/src/points.ts) are the source of truth for
every shape below. Conventions (JSON, errors, Bearer tokens, timestamps) are as in
[`auth.md`](auth.md).

The points are called **Soul points** for now. The name is provisional: UI copy uses
`POINTS_NAME` from `packages/shared`, and code, tables and endpoints say `points`.

## Endpoints

| Method and path       | Auth                  | Body   | Success                               | Errors                                     |
| --------------------- | --------------------- | ------ | ------------------------------------- | ------------------------------------------ |
| `GET /points/balance` | Bearer, active member | (none) | `200` `pointsBalanceResponseSchema`   | `401 unauthorized`, `403 account_not_active` |

There is **no public endpoint that writes points** in #6. Points are written only by server code
through the ledger service below; the features that write them add their own endpoints (#7, #15,
#34) with their own rules.

### `GET /points/balance`

The logged-in member's current balance: the sum of all their ledger entries, read at request
time (never a stored number).

```json
{ "balance": 1250, "asOf": "2026-11-24T10:00:00.000Z" }
```

- A member with no entries gets `{ "balance": 0, ... }`.
- **Only fully active accounts** (`status: "active"`) can see a balance. It uses
  `requireActiveAccount`, so `pending_verification` and `pending_consent` accounts get
  `403 account_not_active` (with the same message as other member features). The web app does
  not call it for those accounts; it shows their pending state instead.
- Any role can call it for their own account (staff can be members too). There is no way to read
  another user's balance here; staff views come with #34.
- `401 unauthorized` for a missing, unknown, expired or revoked access token.
- The response is never cached (`cache-control: no-store`).

## The ledger (server side)

Table `points_ledger_entries`, one row per earn, redeem, adjustment or expiry:

| Column               | Meaning                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------- |
| `id`                 | uuid                                                                                          |
| `user_id`            | the member whose points change (foreign key, `ON DELETE RESTRICT`)                            |
| `entry_type`         | `earn`, `redeem`, `adjustment`, `expiry` (`POINTS_ENTRY_TYPES`)                               |
| `amount`             | signed integer: `earn` > 0; `redeem`, `expiry` < 0; `adjustment` either sign; never 0         |
| `reason`             | human-readable text for history and audit (1 to 500 characters)                               |
| `reference`          | optional pointer to the source record, e.g. `booking:<id>`, `redemption:<id>`                 |
| `idempotency_key`    | identifies the source event; **unique across the ledger**                                     |
| `actor_type`         | `system`, `member` or `staff` (`POINTS_ACTOR_TYPES`)                                          |
| `actor_user_id`      | who did it: null for `system`, required for `member` and `staff`                              |
| `created_at`         | when the entry was recorded                                                                   |

**Rules, enforced by the database as well as the service:**

- **Append-only.** A trigger rejects every `UPDATE` and `DELETE` on `points_ledger_entries`. A
  mistake is corrected by a new `adjustment` entry, so history and audit (#9, #34) stay complete.
  Deleting a user who has entries is refused by the foreign key.
- **The balance is derived.** It is `SUM(amount)` over the member's entries, read through a
  covering index. No balance column exists that could drift. If one is ever added for speed, it
  must be maintained in the same transaction as the insert and checked against the sum.
- **No double counting.** `idempotency_key` has a unique constraint, so one source event can be
  recorded once, even when two requests race.
- Check constraints enforce the sign per entry type, `amount <> 0`, `|amount| <= 1,000,000`, and
  that `actor_user_id` is set exactly when `actor_type` is not `system`.

### Ledger service: `PointsLedger` (`apps/api/src/points/ledger.ts`)

For later issues to call from their own routes and jobs. All amounts passed in are **positive**;
the service stores debits as negative.

```ts
const ledger = new PointsLedger({ db, now });   // or app.pointsLedger

await ledger.credit({
  userId, amount: 100, type: "earn",            // "earn" | "adjustment"
  reason: "Check-in",
  reference: `booking:${bookingId}`,            // optional
  idempotencyKey: `checkin:${bookingId}:${userId}`,
  actor: { type: "system" },                    // or { type: "staff" | "member", userId }
}, tx);                                         // optional: run inside the caller's transaction

await ledger.debit({
  userId, amount: 500, type: "redeem",          // "redeem" | "adjustment" | "expiry"
  reason: "Free coffee", reference: `redemption:${id}`,
  idempotencyKey: `redemption:${id}`,
  actor: { type: "member", userId },
}, tx);

await ledger.balance(userId, tx);               // number
```

`credit` and `debit` return `{ entry, created, balance }`:

- `entry`: the ledger entry (`id`, `userId`, `type`, `amount` (signed), `reason`, `reference`,
  `idempotencyKey`, `actorType`, `actorUserId`, `createdAt`).
- `created`: `true` when this call recorded it; `false` when the same idempotency key had already
  been recorded **for the same entry** (same member, type, signed amount, reference and actor).
  A replay changes nothing and returns the original entry, so callers can retry safely.
- `balance`: the member's balance right after the call.

They throw `LedgerError` with a `code` from `POINTS_LEDGER_ERROR_CODES`:

| Code                     | When                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| `invalid_entry`          | amount not a whole number from 1 to 1,000,000, bad key, empty reason, wrong type or actor  |
| `member_not_found`       | no user with `userId`                                                                      |
| `insufficient_points`    | `debit` for more than the current balance; nothing is written                              |
| `idempotency_key_reused` | the key was already used for a **different** entry                                        |

**Concurrency.** `credit` and `debit` serialise per member with a transaction-scoped advisory
lock, then read the balance, so two debits racing for the same points cannot both succeed and the
balance cannot go below zero. Different members never wait for each other. When the caller passes
its own transaction (`tx`), the lock is held until that transaction ends.

### Refreshing the balance after earn or redeem (#7, #15)

The balance is always read fresh from the ledger, so it is up to date as soon as the entry's
transaction commits. In the web app the home screen's balance (`usePointsBalance`) refetches:

- when the screen mounts, when the window regains focus and when the page becomes visible again;
- when anything calls `notifyPointsChanged()` from `apps/web/src/lib/points/events.ts`.

So the earn (#7) and redeem (#15) features call `notifyPointsChanged()` after a successful
response, and the home balance updates without a reload. A push notification after an earn at
reception (another device) can call it too.

## Trying it locally

With no earn feature yet, give a test account points with the development script (it writes an
`adjustment` entry through the ledger service, to `DATABASE_URL`):

```bash
pnpm --filter @padelloyalty/api points:credit you@example.com 250 "Welcome bonus (test)"
pnpm --filter @padelloyalty/api points:credit you@example.com -50    # a negative amount debits
```

It refuses to run with `NODE_ENV=production`. It is a script, not an endpoint.

## Testing hooks (API)

- `buildApp({ auth })` also registers `GET /points/balance` and decorates `app.pointsLedger`
  (a `PointsLedger` on the same database and clock).
- Tests can also construct `new PointsLedger({ db })` directly on the test database.
