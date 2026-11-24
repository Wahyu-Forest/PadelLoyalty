# Auth API (issue #1)

Email + password accounts, email verification, password reset and token sessions.
Under-18 guardian consent (#3), including the date of birth now required at sign-up, is in
[`consent.md`](consent.md).
The Zod schemas in [`packages/shared/src/auth.ts`](../../packages/shared/src/auth.ts) are the
source of truth for every request and response shape below. The design rationale is in
[`docs/ARCHITECTURE.md`](../ARCHITECTURE.md#authentication).

## Conventions

- JSON in and out (`content-type: application/json`).
- Authenticated calls send `Authorization: Bearer <accessToken>`. No cookies are used.
- Emails are normalised: trimmed and lower-cased (`emailSchema`).
- Every error has the body `{ "error": { "code", "message", "fieldErrors"? } }` (`apiErrorResponseSchema`).
- Timestamps are ISO 8601 UTC strings.

## Endpoints

| Method and path                    | Auth   | Body (schema)                       | Success                                | Errors                                                     |
| ---------------------------------- | ------ | ----------------------------------- | -------------------------------------- | ---------------------------------------------------------- |
| `POST /auth/signup`                | none   | `signUpRequestSchema`               | `202` `messageResponseSchema`          | `400 validation_error`, `429 rate_limited`                 |
| `POST /auth/verify-email`          | none   | `verifyEmailRequestSchema`          | `200` `verifyEmailResponseSchema`      | `400 validation_error`, `400 invalid_token`, `429`         |
| `POST /auth/verify-email/resend`   | none   | `resendVerificationRequestSchema`   | `202` `messageResponseSchema`          | `400 validation_error`, `429 rate_limited`                 |
| `POST /auth/login`                 | none   | `logInRequestSchema`                | `200` `authSessionResponseSchema`      | `400 validation_error`, `401 invalid_credentials`, `429`   |
| `POST /auth/refresh`               | none   | `refreshRequestSchema`              | `200` `authSessionResponseSchema`      | `400 validation_error`, `401 invalid_refresh_token`        |
| `POST /auth/logout`                | none   | `logOutRequestSchema`               | `204` (no body)                        | `400 validation_error`                                     |
| `GET /auth/me`                     | Bearer | (none)                              | `200` `meResponseSchema`               | `401 unauthorized`                                         |
| `POST /auth/password-reset/request`| none   | `passwordResetRequestSchema`        | `202` `messageResponseSchema`          | `400 validation_error`, `429 rate_limited`                 |
| `POST /auth/password-reset/confirm`| none   | `passwordResetConfirmRequestSchema` | `200` `messageResponseSchema`          | `400 validation_error`, `400 invalid_token`, `429`         |

### `POST /auth/signup`

Creates a member account (`role: "member"`, `status: "pending_verification"`) and emails a
verification link. Password rules: 10 to 128 characters, no composition rules.
Body `{ email, password, dateOfBirth, guardianEmail? }`: `dateOfBirth` (`YYYY-MM-DD`) is required
for everyone, and `guardianEmail` for members under 18 (#3, see [`consent.md`](consent.md)).

**No account enumeration:** the response is the same `202` and message whether or not the email
is already registered. If it is, no account is created; instead that address receives either a
fresh verification link (account still unverified) or an "account already exists" email
pointing to log in / reset password. Sign-up does not log the user in.

### `POST /auth/verify-email`

Body `{ token }` from the verification link. Marks the email verified and moves the account
from `pending_verification` to `active`, or to `pending_consent` for an under-18 member (whose
guardian is then emailed, see [`consent.md`](consent.md)). Returns `{ message, accountStatus }`.
The token is single-use and expires after **24 hours**. Unknown, used or expired tokens:
`400 invalid_token`. Requesting a new link invalidates older unused ones.

### `POST /auth/verify-email/resend`

Body `{ email }`. Always `202` with the same message. Sends a new link only if the account
exists and is unverified.

### `POST /auth/login`

Body `{ email, password }`. Returns a session:

```json
{
  "user": { "id": "…", "email": "ana@example.com", "role": "member", "status": "active", "emailVerified": true, "createdAt": "…" },
  "accessToken": "pla_…",
  "accessTokenExpiresAt": "…",
  "refreshToken": "plr_…",
  "refreshTokenExpiresAt": "…"
}
```

- Unknown email and wrong password give the **same** `401 invalid_credentials` response
  (and similar timing: a dummy hash is verified for unknown emails).
- Unverified accounts **can** log in; `user.status` is `pending_verification` and the app asks
  them to verify. `pending_consent` accounts (#3) can log in too. Features that need a fully
  active account use `requireActiveAccount` (`403 account_not_active`), see [`consent.md`](consent.md).
- Access token lifetime: **15 minutes**. Refresh token: **30 days**, renewed on every refresh.

### `POST /auth/refresh`

Body `{ refreshToken }`. Returns a new session (same shape as login) with a **new** access token
and a **new** refresh token. The old refresh token stops working immediately (rotation).
Presenting an already-rotated refresh token again is treated as theft: the whole session is
revoked and `401 invalid_refresh_token` is returned (the latest refresh token stops working too).
Unknown, expired or revoked tokens: `401 invalid_refresh_token`.

### `POST /auth/logout`

Body `{ refreshToken }`. Revokes that session: its access and refresh tokens stop working at
once. Always `204`, also for unknown or already-revoked tokens (idempotent).

### `GET /auth/me`

Returns `{ user }` for the session of the bearer access token. Missing, malformed, unknown,
expired or revoked token: `401 unauthorized`.

### `POST /auth/password-reset/request`

Body `{ email }`. Always `202` with the same message. If the account exists, emails a reset link.
The token is single-use and expires after **1 hour**; requesting a new one invalidates older
unused reset links.

### `POST /auth/password-reset/confirm`

Body `{ token, password }` (same password rules as sign-up). Sets the new password, uses up the
token, **revokes every session of the account** (log out everywhere) and, because the link
proves the user owns the email, marks the email verified if it was not. Unknown, used or expired
tokens: `400 invalid_token`.

## Email links

Links point at the web app (`APP_URL`, which includes the base path on GitHub Pages). The token
is in the URL **fragment**, so it is never sent to the web host or leaked in `Referer` headers:

- Verify: `{APP_URL}/verify-email/#token=<token>`
- Reset: `{APP_URL}/reset-password/#token=<token>`

## Rate limits

Counted in memory per API process (see limitations in ARCHITECTURE.md). Over the limit the API
answers `429 rate_limited` with a `Retry-After` header (seconds). Defaults:

| Rule (`rateLimits` key) | Applies to                                                      | Limit             |
| ----------------------- | --------------------------------------------------------------- | ----------------- |
| `loginPerIp`            | every `POST /auth/login` from one IP                            | 30 per 15 minutes |
| `loginFailuresPerEmail` | failed logins for one email (known or not); success resets it   | 5 per 15 minutes  |
| `signupPerIp`           | `POST /auth/signup` from one IP                                 | 10 per hour       |
| `emailRequestsPerIp`    | resend verification + reset request, from one IP                | 20 per hour       |
| `emailRequestsPerEmail` | resend verification + reset request, per email (known or not)   | 3 per hour        |
| `tokenAttemptsPerIp`    | verify-email + reset confirm (+ consent review and decision), from one IP | 20 per 15 minutes |

Guardian consent adds `consentRequestsPerAccount` and `consentEmailsPerGuardian`; see
[`consent.md`](consent.md#rate-limits-added).

Limits are counted for unknown emails exactly as for registered ones, so a `429` never reveals
whether an email is registered.

## Roles and statuses

- `role`: `member` (default), `receptionist`, `club_manager`, `admin`. Only `member` is created
  through the API today; staff roles are assigned by later issues.
- `status`: `pending_verification` → `active`, or `pending_verification` → `pending_consent` →
  `active` for under-18s (#3). Only `active` is fully active (`isAccountFullyActive`).

## Testing hooks (API)

Integration tests build the app with `buildApp` from `apps/api/src/app.ts`:

```ts
import { buildApp } from "../src/app.js";
import { CapturingMailer } from "../src/email/mailer.js";

const mailer = new CapturingMailer();
const app = await buildApp({
  checkDatabase: async () => true,
  corsOrigins: [],
  auth: {
    db,                               // Drizzle database (createDatabase(TEST_DATABASE_URL).db)
    mailer,                           // captures emails instead of sending them
    appUrl: "http://app.test",        // base of the links in emails
    now: () => clock,                 // optional: control time for expiry tests
    rateLimits: { loginFailuresPerEmail: { max: 2, windowMs: 60_000 } }, // optional overrides; `false` disables all
  },
});
```

- `mailer.messages` is every email sent, in order: `{ to, type, subject, text, link }` where
  `type` is `"verify_email" | "password_reset" | "account_exists" | "guardian_consent"` and
  `link` is the full URL.
- `mailer.lastTo(email, type?)` returns the latest email to that address; `mailer.clear()` empties it.
- `tokenFromLink(link)` (same module) extracts the token from a link's `#token=` fragment.
- Rate limiter state lives in the app instance: a new `buildApp` starts with clean counters.
- Without `auth`, the auth routes are not registered (the `/health` tests use this).
