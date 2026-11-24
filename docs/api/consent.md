# Guardian consent API (issue #3)

Members under 18 need a parent or guardian's consent before their account is fully active.
Consent is given by **email link to the guardian** (decided 18 Nov 2026). The Zod schemas in
[`packages/shared/src/consent.ts`](../../packages/shared/src/consent.ts),
[`packages/shared/src/auth.ts`](../../packages/shared/src/auth.ts) and
[`packages/shared/src/age.ts`](../../packages/shared/src/age.ts) are the source of truth for every
shape below. Conventions (JSON, errors, Bearer tokens, timestamps) are as in [`auth.md`](auth.md).

> **Safeguarding Policy: not reviewed yet.** Soul Padel's Safeguarding Policy has not been
> supplied. The consent page and email show `SAFEGUARDING_POLICY_PLACEHOLDER` where the policy
> should be linked or summarised. The flow must be reviewed against the policy before launch.

## The flow

1. **Sign-up** (`POST /auth/signup`): everyone gives a `dateOfBirth`. If the member is under 18
   on the day of sign-up, `guardianEmail` is required and must differ from the member's email.
   The account starts as `pending_verification`. **Nothing is sent to the guardian yet.**
2. **Member verifies their own email first** (`POST /auth/verify-email`). An under-18 account
   moves to `pending_consent` (not `active`) and the guardian is emailed a consent link.
   Verifying first means our emails to a guardian are only ever triggered by someone who controls
   a real mailbox, so sign-up cannot be used to send emails to arbitrary addresses.
3. **Guardian opens the link** (`{APP_URL}/guardian-consent/#token=…`), the page loads the
   details (`POST /auth/consent/review`) and the guardian **confirms or declines**
   (`POST /auth/consent/decision`).
   - Confirm: the account becomes `active`.
   - Decline: the account stays `pending_consent`; the member can nominate a different guardian.
4. Meanwhile the member can log in, sees why the account is pending (`GET /auth/consent`), and
   can resend the request or change the guardian (`POST /auth/consent/request`).

Age is computed on calendar dates (`ageOn` in `packages/shared/src/age.ts`): it goes up on the
birthday itself, and a 29 February birthday counts from 1 March in other years. The threshold is
`ADULT_AGE = 18`. The API uses **today's date in UTC**.

## Endpoints

| Method and path                 | Auth   | Body (schema)                  | Success                              | Errors                                                                                       |
| ------------------------------- | ------ | ------------------------------ | ------------------------------------ | -------------------------------------------------------------------------------------------- |
| `POST /auth/signup`             | none   | `signUpRequestSchemaOn(today)` | `202` `messageResponseSchema`        | `400 validation_error`, `429 rate_limited`                                                   |
| `GET /auth/consent`             | Bearer | (none)                         | `200` `consentStatusResponseSchema`  | `401 unauthorized`                                                                           |
| `POST /auth/consent/request`    | Bearer | `consentRequestRequestSchema`  | `200` `consentStatusResponseSchema`  | `400 validation_error`, `401`, `409 consent_not_required`, `409 guardian_declined`, `429`    |
| `POST /auth/consent/review`     | none   | `consentReviewRequestSchema`   | `200` `consentReviewResponseSchema`  | `400 validation_error`, `400 invalid_token`, `429`                                           |
| `POST /auth/consent/decision`   | none   | `consentDecisionRequestSchema` | `200` `consentDecisionResponseSchema`| `400 validation_error`, `400 invalid_token`, `429`                                           |

Any member feature that needs a fully active account answers `403 account_not_active` for
`pending_verification` and `pending_consent` accounts (see [Fully active](#fully-active-accounts)).

### `POST /auth/signup` (changed)

Body `{ email, password, dateOfBirth, guardianEmail? }`.

- `dateOfBirth`: `YYYY-MM-DD`, a real calendar date (no `2025-02-29`, `2025-04-31`, month 13),
  not before `1900-01-01`, not after today. Field error key `dateOfBirth`.
- `guardianEmail`: normalised like every email. **Required when the member is under 18** on
  today's date; must differ from `email` (field error key `guardianEmail` for both). Ignored and
  not stored for adults.
- Response, rate limits and no-enumeration are unchanged: same `202` and message whether or not
  the email is registered. Signing up again with a registered email changes nothing about the
  existing account (its date of birth and guardian stay as they were).

### `POST /auth/verify-email` (changed)

`accountStatus` in the response is `pending_consent` for an under-18 member, `active` otherwise.
On the move to `pending_consent` the guardian is emailed (email type `guardian_consent`). The
same happens when an unverified under-18 member verifies by resetting their password
(`POST /auth/password-reset/confirm`). If the member turned 18 between sign-up and verifying,
they go straight to `active`.

### `GET /auth/consent`

The logged-in member's consent status:

```json
{
  "state": "pending",
  "guardianEmail": "mum@example.com",
  "requestedAt": "2026-11-24T10:00:00.000Z",
  "expiresAt": "2026-12-01T10:00:00.000Z",
  "decidedAt": null
}
```

`state` is one of (`CONSENT_STATES`):

| `state`                        | Meaning                                                                         | Account status         |
| ------------------------------ | ------------------------------------------------------------------------------- | ---------------------- |
| `not_required`                 | Adult, or an account from before #3 (no date of birth)                          | any                    |
| `awaiting_member_verification` | Under 18; the member's own email is not verified yet, so the guardian isn't emailed yet | `pending_verification` |
| `not_sent`                     | Verified, but no consent email went out (the guardian's email was rate limited) | `pending_consent`      |
| `pending`                      | Link emailed and still valid                                                    | `pending_consent`      |
| `expired`                      | The latest link expired unused                                                  | `pending_consent`      |
| `declined`                     | The guardian declined the latest request                                        | `pending_consent`      |
| `granted`                      | A guardian confirmed                                                            | `active`               |

`requestedAt`, `expiresAt`, `decidedAt` describe the latest consent email (null if none).
`guardianEmail` is null only for `not_required`.

### `POST /auth/consent/request`

Body `{}` to **resend** to the current guardian, or `{ "guardianEmail": "…" }` to **change** the
guardian (and send to the new one). Returns the new consent status (`200`).

- Each send creates a new link and **invalidates every older link** for this member.
- `pending_consent` account: sends the email (state becomes `pending`).
- `pending_verification` under-18 account: only stores a new `guardianEmail` (if given); nothing is
  sent until the member verifies (state stays `awaiting_member_verification`).
- `guardianEmail` equal to the member's own email: `400 validation_error`, field `guardianEmail`.
- The target guardian already **declined** a request from this member: `409 guardian_declined`.
  The member must nominate someone else (this stops repeated emails to a guardian who said no).
- Adult or already active account: `409 consent_not_required`.
- Rate limits: `emailRequestsPerIp`, `consentRequestsPerAccount`, `consentEmailsPerGuardian`
  (see below). Over the limit: `429 rate_limited` with `Retry-After`.

### `POST /auth/consent/review`

Body `{ token }` from the link. Returns what the guardian is asked to consent to, **without
using up the link**:

```json
{
  "memberEmail": "kid@example.com",
  "memberDateOfBirth": "2012-05-01",
  "guardianEmail": "mum@example.com",
  "expiresAt": "2026-12-01T10:00:00.000Z"
}
```

Unknown, expired, already used or replaced (by a resend or guardian change) links:
`400 invalid_token`, identical for every case.

### `POST /auth/consent/decision`

Body `{ token, decision: "confirm", isParentOrGuardian: true }` or
`{ token, decision: "decline" }`. Confirming requires `isParentOrGuardian: true` (the guardian
states they are the member's parent or legal guardian; recorded with the consent). Returns
`{ message, decision }`.

- **Single use:** the link works for one decision only. A second decision, or a review after it,
  gives `400 invalid_token`. Two simultaneous decisions: exactly one wins.
- `confirm`: the account moves from `pending_consent` to `active`.
- `decline`: the account stays `pending_consent` and `GET /auth/consent` shows `declined`.
- Links expire after **7 days** (`GUARDIAN_CONSENT_LINK_DAYS`).

## Fully active accounts

`isAccountFullyActive(status)` in `packages/shared` is the one rule: only `active` counts. In the
API, routes for member features add the preHandler `requireActiveAccount(service)` from
`apps/api/src/auth/routes.ts` (it includes `requireAuth`). It answers `401 unauthorized` without a
valid token and `403 account_not_active` for `pending_verification` / `pending_consent`, with a
message saying why. There are no booking or points routes yet; later features use this check.

## Consent record (audit)

Table `guardian_consent_requests`, one row per consent email sent. Rows are never deleted by the
flow (a user with consent records cannot be deleted by accident: the foreign key restricts it).

| Column                    | Meaning                                                              |
| ------------------------- | -------------------------------------------------------------------- |
| `user_id`                 | The member                                                           |
| `guardian_email`          | Who was asked (and, once decided, who decided)                       |
| `member_date_of_birth`    | The date of birth the request was made for                           |
| `method`                  | How: `email_link` (the only method today)                            |
| `status`                  | `pending`, `confirmed`, `declined`, `superseded` (replaced by a newer request) |
| `requested_at`, `expires_at` | When the link was sent and when it expires                        |
| `decided_at`              | When the guardian confirmed or declined                              |
| `decided_ip`, `decided_user_agent` | Where the decision came from                                |
| `guardian_attested`       | True when the guardian stated they are the parent or legal guardian |
| `superseded_at`           | When a resend or guardian change replaced this request               |
| `token_hash`              | SHA-256 of the link token (the token itself is never stored)         |

## Emails

- Type `guardian_consent`, to the guardian, link `{APP_URL}/guardian-consent/#token=plc_…`
  (token in the fragment, as for the other email links). It names the member's email, says what
  the app is, that the link expires in 7 days and works once, and that they can decline or ignore
  it if they don't know the member.

## Rate limits (added)

| Rule (`rateLimits` key)      | Applies to                                                         | Limit             |
| ---------------------------- | ------------------------------------------------------------------ | ----------------- |
| `consentRequestsPerAccount`  | `POST /auth/consent/request`, per member account                   | 5 per hour        |
| `consentEmailsPerGuardian`   | consent emails to one guardian address (also the first one, sent on verification) | 5 per hour |
| `emailRequestsPerIp` (existing) | also counts `POST /auth/consent/request`                        | 20 per hour       |
| `tokenAttemptsPerIp` (existing) | also counts consent review and decision                         | 20 per 15 minutes |

If the guardian limit is hit when the member verifies, verification still succeeds and no email
is sent (state `not_sent`); the member can send it later.

## Edge cases

- **Guardian declines:** account stays `pending_consent`; the member sees "declined" and can
  nominate a different guardian. Asking the same guardian again is refused
  (`409 guardian_declined`). If that guardian changes their mind, Soul Padel staff will need to
  help (no staff tool yet: follow-up).
- **Link expires:** state `expired`; the member resends (new 7-day link).
- **Member changes the guardian email:** `POST /auth/consent/request { guardianEmail }`. The old
  guardian's link stops working at once.
- **Existing adult accounts** (created before #3, no date of birth): stay `active`; consent state
  `not_required`. Asking them for a date of birth is a follow-up.
- **Turning 18 later:** no automation. A member who turns 18 while `pending_consent` stays
  pending until a guardian confirms (or staff step in). A member who turns 18 before verifying
  their email becomes `active` on verification. Promoting pending members on their 18th birthday
  is a possible follow-up.
- **Guardian also has an account, or is a guardian for several members:** allowed. Each member
  has their own requests.
- **Time zone:** "today" is the UTC date, so around midnight a birthday can count up to a day
  early or late compared with the club's local date. A club time zone setting is a follow-up.

## Testing hooks (API)

As in [`auth.md`](auth.md#testing-hooks-api), plus:

- `mailer.messages` has `type: "guardian_consent"` emails, sent `to` the guardian;
  `tokenFromLink(link)` works for them too.
- Sign-up bodies need a `dateOfBirth`; use one well over 18 years before the test clock for adults.
- To test `requireActiveAccount`, register a route on the built app:
  `app.get("/x", { preHandler: requireActiveAccount(app.authService!) }, …)` before `app.ready()`.
