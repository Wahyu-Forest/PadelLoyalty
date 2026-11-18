# PadelLoyalty

Soul Padel's member app (court bookings and the Soul points loyalty programme) for iOS, Android and the web, plus a staff back office. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the design.

**Live preview:** https://wahyu-forest.github.io/PadelLoyalty/ (staff: https://wahyu-forest.github.io/PadelLoyalty/admin/), deployed from `main`. See [Deployment](#deployment-github-pages).

## Repo layout

```
apps/
  web/        Next.js (App Router) static export: members at /, staff at /admin.
              Wrapped by Capacitor for iOS/Android (capacitor.config.ts, android/).
  api/        Fastify API, Drizzle ORM, migrations in apps/api/drizzle/
packages/
  shared/     Zod schemas and types used by both web and API
docs/         Architecture notes
```

Tooling: pnpm workspaces, Turborepo, TypeScript (strict), ESLint, Prettier, Vitest, Playwright, GitHub Actions.

## Prerequisites

- **Node.js 22** or newer (`.nvmrc`), and **pnpm 10** (`corepack enable` picks up the version in `package.json`)
- **PostgreSQL 16**: easiest with Docker (`docker compose`), or any local Postgres you run yourself
- For the native apps only: Android Studio + JDK 21 (Android), and a Mac with Xcode (iOS)

## Setup

```bash
pnpm install

# Start Postgres (creates the `padelloyalty` and `padelloyalty_test` databases)
docker compose up -d

# Environment files (defaults match docker-compose.yml)
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local

# Create the database tables
pnpm db:migrate
```

### Without Docker

Use any PostgreSQL 16 and create the role and databases yourself, then point `DATABASE_URL` / `TEST_DATABASE_URL` in `apps/api/.env` at them:

```bash
psql -U postgres -c "CREATE ROLE padel LOGIN PASSWORD 'padel' CREATEDB;"
psql -U postgres -c "CREATE DATABASE padelloyalty OWNER padel;"
psql -U postgres -c "CREATE DATABASE padelloyalty_test OWNER padel;"
```

## Run

```bash
pnpm dev
```

- Web app: http://localhost:3000 (member home) and http://localhost:3000/admin (staff)
- API: http://localhost:4000/health

Both pages call the API's `GET /health` and show whether the API and the database are up.

`GET /health` returns `200 {"status":"ok","database":"up",...}` when PostgreSQL is reachable, and `503 {"status":"degraded","database":"down",...}` when it is not. The response shape is `healthResponseSchema` in `packages/shared`.

### Configuration

| Variable                | Where                    | Default                                                         | Purpose                                                                                    |
| ----------------------- | ------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `DATABASE_URL`          | `apps/api/.env`          | (required)                                                      | PostgreSQL for the API and `db:migrate`                                                    |
| `TEST_DATABASE_URL`     | `apps/api/.env` or shell | (required for `pnpm test`; no fallback)                         | Database the API integration tests migrate. Must differ from `DATABASE_URL`                |
| `HOST`, `PORT`          | `apps/api/.env`          | `0.0.0.0`, `4000`                                               | Where the API listens                                                                      |
| `CORS_ORIGINS`          | `apps/api/.env`          | `http://localhost:3000,capacitor://localhost,https://localhost` | Browser origins allowed to call the API                                                    |
| `LOG_LEVEL`             | `apps/api/.env`          | `info`                                                          | Fastify log level                                                                          |
| `NEXT_PUBLIC_API_URL`   | `apps/web/.env.local`    | `http://localhost:4000`                                         | API base URL for the web app. **Inlined at build time**: rebuild after changing it         |
| `NEXT_PUBLIC_BASE_PATH` | build env                | (unset: served from `/`)                                        | URL path the export is served under. Only the GitHub Pages build sets it (`/PadelLoyalty`) |

`NEXT_PUBLIC_API_URL` unset means `http://localhost:4000`. Set but empty means the build has no API: the status panel shows "API unreachable" without making a request.

Never commit `.env` files; only the `.env.example` files are tracked.

## Test and check

Run from the repo root:

| Command          | What it does                                                                                                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint`      | ESLint in every package, then `prettier --check`                                                                                                                                               |
| `pnpm typecheck` | `tsc --noEmit` in every package                                                                                                                                                                |
| `pnpm test`      | Vitest unit tests in every package, plus the API integration tests against a real Postgres (needs `TEST_DATABASE_URL`, from the shell or `apps/api/.env`; it runs migrations on that database) |
| `pnpm build`     | Builds `packages/shared`, the API (`apps/api/dist`) and the web static export (`apps/web/out`)                                                                                                 |
| `pnpm test:e2e`  | Builds the web app and runs the Playwright smoke test (desktop and phone viewport) against the static export. The API is stubbed in these tests                                                |
| `pnpm format`    | Rewrites files with Prettier                                                                                                                                                                   |

To run the same suite against a build served under a subpath, as on GitHub Pages: `NEXT_PUBLIC_BASE_PATH=/PadelLoyalty pnpm test:e2e`. It serves `out/` at `http://localhost:3100/PadelLoyalty/` with `apps/web/e2e/serve-static.mjs`, which behaves like Pages.

First time with Playwright: `pnpm --filter @padelloyalty/web exec playwright install --with-deps chromium`. If you cannot download Playwright's browser but have Google Chrome installed, run `E2E_BROWSER_CHANNEL=chrome pnpm test:e2e`.

CI (`.github/workflows/ci.yml`) runs lint, typecheck, test (with a Postgres service container), build and the Playwright smoke test on every pull request, then runs the smoke test again under the `/PadelLoyalty/` base path.

## Deployment (GitHub Pages)

The web app is published to **https://wahyu-forest.github.io/PadelLoyalty/** by `.github/workflows/pages.yml`, on every push to `main`. It can also be run manually (Actions → "Deploy web app to GitHub Pages" → Run workflow).

How it works:

1. The workflow builds `apps/web` with `NEXT_PUBLIC_BASE_PATH=/PadelLoyalty`, because a project site is served under the repository name. Next.js then prefixes every page link and `/_next` asset with `/PadelLoyalty`. Local, CI and Capacitor builds don't set it and stay at the root.
2. It adds `.nojekyll` to `apps/web/out`, checks that the export uses the base path, and uploads the folder as the Pages artifact.
3. A second job deploys the artifact with `actions/deploy-pages` (permissions `pages: write`, `id-token: write`). Deployments run one at a time (concurrency group `pages`).

**One-time setup (repository owner):**

- **Settings → Pages → Build and deployment → Source: GitHub Actions.** Until this is set, the workflow fails at "Configure Pages". It can't be enabled from the workflow itself.
- Optional: **Settings → Secrets and variables → Actions → Variables →** `PAGES_API_URL`, the HTTPS base URL of a hosted API. While it is unset (there's no hosted API yet), the site shows "API unreachable" and makes no API calls. When an API is hosted, its `CORS_ORIGINS` must include `https://wahyu-forest.github.io`, and the site must be redeployed after changing the variable, because the URL is inlined at build time.

The `github-pages` environment created on the first deploy may restrict which branches can deploy. Keep `main` allowed.

## Database and migrations

- Schema: `apps/api/src/db/schema.ts` (Drizzle ORM)
- After changing the schema, generate a migration and apply it:

  ```bash
  pnpm db:generate   # writes SQL to apps/api/drizzle/
  pnpm db:migrate    # applies pending migrations to DATABASE_URL
  ```

Commit the generated files in `apps/api/drizzle/`, including `meta/`.

## Mobile apps (Capacitor)

The web app is a static export (`apps/web/out`) that Capacitor bundles into native apps. App id: `com.soulpadel.app` (`apps/web/capacitor.config.ts`).

The app on a device or emulator must reach the API, so build with an address it can see, for example `NEXT_PUBLIC_API_URL=http://10.0.2.2:4000` (Android emulator to your machine) or your LAN IP. The API's `CORS_ORIGINS` already allows the Capacitor origins (`https://localhost` on Android, `capacitor://localhost` on iOS).

### Android

The Android project is committed in `apps/web/android/`.

```bash
pnpm build                                        # produce apps/web/out
pnpm --filter @padelloyalty/web exec cap sync android
pnpm --filter @padelloyalty/web run cap:android   # opens Android Studio
```

Run the app from Android Studio, or `cd apps/web/android && ./gradlew assembleDebug`. Plain `http://` API URLs need cleartext traffic allowed for development; use HTTPS for real builds.

### iOS (macOS only)

The iOS project has not been generated yet because it requires macOS. On a Mac with Xcode and CocoaPods:

```bash
pnpm --filter @padelloyalty/web add @capacitor/ios
pnpm build
pnpm --filter @padelloyalty/web exec cap add ios
pnpm --filter @padelloyalty/web run cap:ios       # opens Xcode
```

Commit `apps/web/ios/` (Capacitor's generated `.gitignore` keeps build output out).

After any web change, rebuild and run `cap sync` to copy the new export into the native projects.
