# The Wheel Web App

A Next.js dashboard for managing a Wheel options workflow. The app tracks portfolio value, synced brokerage positions, cash-secured put capacity, covered-call opportunities, scanner candidates, and daily action items.

The current web app uses plain Postgres for login/session storage and SnapTrade for Fidelity brokerage connectivity. Secrets stay outside GitHub in local or deployment environment variables.

## What It Does

- Shows a Robinhood-style portfolio dashboard with chart ranges for Day, Month, Year, and Overall.
- Syncs Fidelity/SnapTrade account balances and positions into Postgres.
- Highlights loss positions in dim red and neutral/profit positions in dim green.
- Provides a Screener for cash-secured put candidates.
- Adds an Action Center for positions that need attention today.
- Flags upcoming earnings and ex-dividend risk before opening or managing options.
- Uses email/password login backed by Postgres sessions.

## Tech Stack

- Next.js 14 App Router
- React 18
- TailwindCSS
- Postgres via `pg`
- SnapTrade SDK
- Yahoo/yfinance-backed market data API routes

## Repo Layout

```text
app/                         Next.js routes and API endpoints
app/api/auth/                Login, register, and logout routes
app/api/snaptrade/           SnapTrade connect/sync routes
app/api/yahoo/               Quote and options scanner routes
components/                  Dashboard and auth UI
db/migrations/               Postgres schema
lib/postgres/                Postgres client, auth, and error helpers
lib/integrations/            SnapTrade and market-data integrations
lib/data.ts                  Server-side dashboard data loader
.env.example                 Safe template for required env vars
```

## Local Setup

1. Install dependencies.

   ```bash
   npm install
   ```

2. Create your local environment file.

   ```bash
   cp .env.example .env.local
   ```

3. Fill in `.env.local`.

   ```bash
   DATABASE_URL=postgresql://...
   DATABASE_SSL=true

   SNAPTRADE_CLIENT_ID=...
   SNAPTRADE_CONSUMER_KEY=...
   SNAPTRADE_USER_ID=...
   SNAPTRADE_USER_SECRET=...
   SNAPTRADE_PRIMARY_ACCOUNT_NUMBER=
   SNAPTRADE_SECONDARY_ACCOUNT_NUMBER=

   LOCAL_DEV_AUTH_AUTO_LOGIN=false
   LOCAL_DEV_AUTH_EMAIL=
   ```

   Do not commit `.env.local`. It contains secrets and is intentionally ignored by git.

4. Apply the Postgres schema.

   If you have `psql` installed:

   ```bash
   psql "$DATABASE_URL" -f db/migrations/0001_postgres_auth_schema.sql
   ```

   If you do not have `psql`, you can run the migration using the app's `pg` dependency from a local script or database UI. The migration file is:

   ```text
   db/migrations/0001_postgres_auth_schema.sql
   ```

5. Start the app.

   ```bash
   npm run dev
   ```

6. Open the app.

   ```text
   http://localhost:3000
   ```

## Login Flow

The app uses its own Postgres-backed login system.

1. Open the site.
2. Click **Create account**.
3. Enter an email and password.
4. After account creation, the app returns you to **Sign in**.
5. Enter the same email/password.
6. If they match, the app creates a session and opens the dashboard.

Passwords are hashed with Node `crypto.scrypt`. Sessions are stored in `app_sessions` and sent to the browser as an http-only `wheel_session` cookie.

For local testing, `LOCAL_DEV_AUTH_AUTO_LOGIN=true` can bypass the login screen when `LOCAL_DEV_AUTH_EMAIL` is set. Keep it `false` when testing the real login flow.

## Secrets

Secrets are not pushed to GitHub.

Use `.env.local` on your laptop:

```bash
DATABASE_URL=...
SNAPTRADE_CLIENT_ID=...
SNAPTRADE_CONSUMER_KEY=...
SNAPTRADE_USER_ID=...
SNAPTRADE_USER_SECRET=...
```

For deployment, add the same values in the hosting provider's environment-variable settings, such as Vercel Project Settings -> Environment Variables.

Use `.env.example` only as a safe template. It should never contain real credentials.

## Postgres

The app expects a Postgres database with the schema from:

```text
db/migrations/0001_postgres_auth_schema.sql
```

The schema includes:

- `app_users`
- `app_sessions`
- `account_snapshots`
- `positions`
- `watchlist`
- `screener_runs`
- `screener_candidates`

Recommended hosted Postgres providers include Neon, Supabase Postgres-only, Render Postgres, Railway, or any standard Postgres 13+ database. For hosted providers, set:

```bash
DATABASE_SSL=true
```

## SnapTrade/Fidelity

SnapTrade credentials are required for live brokerage sync.

The dashboard can still load without SnapTrade credentials, but Connect and Sync actions will show which env vars are missing.

Required values:

```bash
SNAPTRADE_CLIENT_ID=
SNAPTRADE_CONSUMER_KEY=
SNAPTRADE_USER_ID=
SNAPTRADE_USER_SECRET=
```

Optional account filters:

```bash
SNAPTRADE_PRIMARY_ACCOUNT_NUMBER=
SNAPTRADE_SECONDARY_ACCOUNT_NUMBER=
```

## Useful Commands

```bash
npm run dev        # local development server
npm run lint       # lint Next/React code
npm run typecheck  # TypeScript check
npm run build      # production build
```

## Important Routes

- `/` - dashboard or login screen
- `/api/auth/register` - create account, but do not auto-login
- `/api/auth/login` - verify email/password and create session
- `/api/auth/logout` - clear session
- `/api/snaptrade/login` - create SnapTrade/Fidelity reconnect link
- `/api/snaptrade/sync` - sync account snapshots and positions
- `/api/yahoo/quote?ticker=AAPL` - quote route
- `/api/yahoo/options?ticker=AAPL` - options/scanner route

## Common Issues

### Login screen does not appear

You may already have a valid `wheel_session` cookie, or local dev auto-login may be enabled.

Check `.env.local`:

```bash
LOCAL_DEV_AUTH_AUTO_LOGIN=false
```

If needed, clear rows from `app_sessions` in Postgres or sign out from the dashboard Activity tab.

### "Postgres DATABASE_URL is missing"

The app cannot see a database connection string. Add `DATABASE_URL` to `.env.local`, restart `npm run dev`, and make sure the migration has been applied.

### SnapTrade says credentials are missing

Fill in the SnapTrade env vars in `.env.local`, then restart the dev server.

### Hosted Postgres connection fails locally

Most hosted providers require SSL:

```bash
DATABASE_SSL=true
```

## Handoff Notes

For the next intern:

1. Clone the repo.
2. Run `npm install`.
3. Copy `.env.example` to `.env.local`.
4. Ask the manager for real Postgres and SnapTrade secrets.
5. Apply `db/migrations/0001_postgres_auth_schema.sql`.
6. Run `npm run dev`.
7. Create a test account, then sign in manually.
8. Use Activity -> Connect or Sync for Fidelity/SnapTrade.
9. Before pushing, run `npm run lint`, `npm run typecheck`, and `npm run build`.

## Security Notes

- Never commit `.env.local`.
- Never paste credentials into README files, screenshots, commits, or chat messages.
- Keep database URLs and SnapTrade secrets in local env files or hosting environment-variable settings.
- Rotate credentials if they are accidentally exposed.
