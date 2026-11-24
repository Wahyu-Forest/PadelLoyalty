# Clubs, courts, prices and blocks API (issue #56)

Staff set up clubs (name, address, IANA time zone, currency, opening hours), their courts,
slot lengths and prices (standard plus peak bands), and block courts for maintenance or events.
Members' apps read active clubs, courts, prices and blocks through public endpoints; booking
(#23) builds on them.

The Zod schemas in [`packages/shared/src/clubs.ts`](../../packages/shared/src/clubs.ts) are the
source of truth for every request and response shape below. Time helpers are in
[`zoned-time.ts`](../../packages/shared/src/zoned-time.ts), money helpers in
[`money.ts`](../../packages/shared/src/money.ts). Conventions (JSON, bearer tokens, the error
body) are the same as in [`auth.md`](auth.md#conventions).

## Who can do what

| Caller                                       | Public `GET /clubs…` | `/admin/clubs…`                         |
| -------------------------------------------- | -------------------- | --------------------------------------- |
| Anyone, not logged in                        | yes                  | `401 unauthorized`                      |
| `member`                                     | yes                  | `403 forbidden`                         |
| `receptionist`                               | yes                  | `403 forbidden`                         |
| `club_manager`                               | yes                  | `403 forbidden` (until #39, see below)  |
| `admin`, status `active`                     | yes                  | everything, every club                  |
| `admin`, status not `active` (unverified)    | yes                  | `403 account_not_active`                |

Checks run in this order: bearer token (`401 unauthorized`), role (`403 forbidden`), account
status (`403 account_not_active`), then the club in the path (`404 not_found`).

All protection is in the API: the web app is a static export, so hiding `/admin` screens is
only a convenience. The API decides access in one place, `ClubAccessPolicy`
(`apps/api/src/clubs/access.ts`): `canCreateClubs(user)`, `canManageClub(user, clubId)` and
`manageableClubIds(user)`. Today only `admin` passes. When club managers get a club (#39),
`canManageClub` returns true for their club and `manageableClubIds` lists it; the routes
already call these for every club-scoped request, so they need no change.

The back office (`/admin`) shows a clear "no access" message to members and a log-in prompt to
logged-out visitors. Staff roles other than admin see the back office but not club setup.

### Creating the first admin

There is no UI for roles yet. Promote an existing, **email-verified** account from the command
line (it uses `DATABASE_URL` from `apps/api/.env`):

```bash
pnpm --filter @padelloyalty/api admin:create someone@example.com
```

It prints what changed and exits non-zero if the account does not exist or its email is not
verified. Running it again for an admin is harmless. The user's next request sees the new role
(log out and in again in the web app to refresh the role shown). Tests can call the same
function: `promoteToAdmin(db, email)` from `apps/api/src/admin/promote.ts`.

## Domain rules

- **Time zone per club.** `timeZone` is an IANA name (`Europe/London`, `Asia/Jakarta`, `UTC`).
  Offsets (`+01:00`) and abbreviations (`BST`) are rejected because they ignore daylight saving.
  Opening hours, price bands and block times are wall-clock times in the club's zone.
- **Money** is an integer number of minor units (`amountMinor`: pence for GBP) plus the club's
  ISO 4217 `currency` (default `GBP`). No floats anywhere. Changing the currency of a club that
  has prices is refused (`409 currency_locked`): delete the prices first, so 3000 pence can
  never silently become 3000 yen.
- **Quarter-hour grid.** Opening and band times use `HH:MM` on :00, :15, :30, :45. `24:00`
  means end of day. Slot lengths are 30 to 240 minutes in steps of 15.
- **Opening hours**: all seven days (`mon` … `sun`) are required; `null` means closed; one
  period per day, `opens` before `closes`. Opening past midnight is not supported.
- **Pricing** (`clubPricingSchema`):
  - `slotLengthsMinutes`: 1 to 4 distinct lengths members can book, e.g. `[60, 90]`.
  - `standardPrices`: exactly one price per slot length. This is the off-peak price and the
    **fallback**: any time no band covers uses it, so every opening hour always has a price.
  - `bands`: up to 20 peak (or other) bands, each with a `label`, `days`, `starts`, `ends`
    and exactly one price per slot length. Bands must not overlap on any shared day. They do
    not have to lie inside opening hours (a band outside them is simply never used).
  - A slot's price is decided by its **start time**: the band with `starts <= start < ends` on
    that weekday, else the standard price (`priceForSlot` in shared). A 90-minute slot starting
    16:30 before a 17:00 peak is charged off-peak.
  - Responses return lists sorted (slot lengths ascending, days Monday first).
- **Deactivating** a club or court (`active: false`) hides it from members and future booking;
  nothing is deleted. Courts and clubs have no delete endpoint. The database restricts deleting
  a court that has blocks (and, later, bookings).
- **Court blocks**: `startsLocal`/`endsLocal` (`YYYY-MM-DDTHH:MM`) are converted with the
  club's time zone and stored as UTC instants. A time skipped when the clocks go forward is
  rejected; in the repeated hour when they go back, the earlier instant is used. The end must
  be after the start once converted. Blocks may overlap each other and may be on inactive
  courts. Removing a block marks it cancelled (kept for the record). A non-cancelled block
  makes every slot that overlaps `[startsAt, endsAt)` unbookable: #23 must check
  `ClubService.findBlockingBlocks(courtId, startsAt, endsAt)` in its booking transaction.

## Endpoints

### Public (no auth)

| Method and path                  | Query                             | Success                                     | Errors                                  |
| -------------------------------- | --------------------------------- | ------------------------------------------- | --------------------------------------- |
| `GET /clubs`                     |                                   | `200` `publicClubListResponseSchema`        |                                         |
| `GET /clubs/:clubId`             |                                   | `200` `publicClubDetailResponseSchema`      | `404 not_found` (unknown or inactive)   |
| `GET /clubs/:clubId/blocks`      | `publicCourtBlocksQuerySchema`    | `200` `publicCourtBlockListResponseSchema`  | `400 validation_error`, `404 not_found` |

- `GET /clubs`: active clubs, ordered by name.
- `GET /clubs/:clubId`: the club, its **active** courts (ordered by name) and `pricing`
  (`null` when not set up: the club can't be booked yet).
- `GET /clubs/:clubId/blocks?from=…&to=…`: non-cancelled blocks on the club's active courts
  that overlap `[from, to)`. Both ISO 8601 date-times (with `Z` or an offset), `to` after
  `from`, at most 62 days apart. Only `courtId`, `startsAt`, `endsAt` (no reason or note).

### Admin (Bearer, role rules above)

| Method and path                                  | Body / query                         | Success                                | Errors (besides 401/403)                                      |
| ------------------------------------------------ | ------------------------------------ | -------------------------------------- | ------------------------------------------------------------- |
| `GET /admin/clubs`                               |                                      | `200` `adminClubListResponseSchema`    |                                                               |
| `POST /admin/clubs`                              | `createClubRequestSchema`            | `201` `clubResponseSchema`             | `400 validation_error`, `409 club_name_taken`                 |
| `GET /admin/clubs/:clubId`                       |                                      | `200` `adminClubDetailResponseSchema`  | `404 not_found`                                               |
| `PATCH /admin/clubs/:clubId`                     | `updateClubRequestSchema`            | `200` `clubResponseSchema`             | `400`, `404`, `409 club_name_taken`, `409 currency_locked`    |
| `POST /admin/clubs/:clubId/courts`               | `createCourtRequestSchema`           | `201` `courtResponseSchema`            | `400`, `404`, `409 court_name_taken`                          |
| `PATCH /admin/clubs/:clubId/courts/:courtId`     | `updateCourtRequestSchema`           | `200` `courtResponseSchema`            | `400`, `404`, `409 court_name_taken`                          |
| `PUT /admin/clubs/:clubId/pricing`               | `clubPricingSchema`                  | `200` `pricingResponseSchema`          | `400`, `404`                                                  |
| `DELETE /admin/clubs/:clubId/pricing`            |                                      | `204`                                  | `404`                                                         |
| `GET /admin/clubs/:clubId/blocks`                | `listCourtBlocksQuerySchema`         | `200` `courtBlockListResponseSchema`   | `400`, `404`                                                  |
| `POST /admin/clubs/:clubId/blocks`               | `createCourtBlocksRequestSchemaIn`   | `201` `courtBlockListResponseSchema`   | `400`, `404`                                                  |
| `DELETE /admin/clubs/:clubId/blocks/:blockId`    |                                      | `204`                                  | `404`                                                         |

Details:

- **Ids** in paths are UUIDs; anything else, an unknown id, or a court/block of another club
  gives `404 not_found`.
- **Validation errors** list messages under the top-level field: nested problems (one day's
  hours, one band) appear under `openingHours`, `bands`, etc., with the day or band named in
  the message.
- `GET /admin/clubs`: every club (active or not), ordered by name, with `courtCount`,
  `activeCourtCount` and `hasPricing`.
- `POST /admin/clubs`: `name`, `address`, `timeZone`, `openingHours` required; `currency`
  defaults to `GBP` (upper-cased), `active` to `true`. Names are unique ignoring case.
- `PATCH /admin/clubs/:clubId`: any subset of the create fields. `openingHours` replaces the
  whole week. Changing `currency` while pricing exists: `409 currency_locked`.
- `GET /admin/clubs/:clubId`: the club, **all** its courts (ordered by name) and `pricing` or
  `null`.
- Courts: `name` (unique within the club, ignoring case), `environment` (`indoor` |
  `outdoor`), `active` (default `true`). Deactivate with `PATCH … { "active": false }`;
  reactivate with `true`.
- `PUT …/pricing` replaces the whole pricing (slot lengths, standard prices, bands) and
  returns it normalised. `DELETE …/pricing` removes it (idempotent).
- `POST …/blocks`: `{ courtIds, startsLocal, endsLocal, reason, note? }` creates one block per
  court, all or nothing. `courtIds` must be distinct courts of this club (otherwise
  `400 validation_error` on `courtIds`). `reason`: `maintenance` | `event` | `other`.
  Returns the new blocks ordered by court name.
- `GET …/blocks?from&to&courtId&includeCancelled`: blocks overlapping `[from, to)`. `from`
  defaults to now (past blocks hidden), `to` to no limit. Cancelled blocks only with
  `includeCancelled=true`. Ordered by `startsAt`, then court name.
- `DELETE …/blocks/:blockId`: marks the block cancelled (`cancelledAt`); idempotent.

### Example: pricing

```json
{
  "slotLengthsMinutes": [60, 90],
  "standardPrices": [
    { "minutes": 60, "amountMinor": 3000 },
    { "minutes": 90, "amountMinor": 4200 }
  ],
  "bands": [
    {
      "label": "Peak",
      "days": ["mon", "tue", "wed", "thu", "fri"],
      "starts": "17:00",
      "ends": "22:00",
      "prices": [
        { "minutes": 60, "amountMinor": 4000 },
        { "minutes": 90, "amountMinor": 5600 }
      ]
    }
  ]
}
```

### Example: block two courts for an event

```json
{
  "courtIds": ["…", "…"],
  "startsLocal": "2026-12-12T09:00",
  "endsLocal": "2026-12-12T14:00",
  "reason": "event",
  "note": "Christmas tournament"
}
```

## Not in this issue

Availability and booking (#23); per-court or indoor/outdoor price differences; split opening
hours (e.g. a lunch closure) and opening past midnight; editing a block (cancel and re-create);
club managers scoped to a club (#39); a staff audit log beyond the block's created/cancelled by
(#34); role management UI.
