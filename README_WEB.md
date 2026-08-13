# The Wheel Web App

This repo now includes a Next.js 14 web version of the original Tkinter Treasury Wheel app.

## Stack

- Frontend: Next.js 14 App Router and TailwindCSS
- Database/Auth: plain Postgres with app-managed email/password sessions
- Deployment: Vercel
- Finance APIs: server-side Next API routes for Yahoo Finance and SnapTrade

## Local setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create `.env.local` from `.env.example` and fill in Postgres and SnapTrade values.

   ```bash
   cp .env.example .env.local
   ```

   For local Postgres, use a connection string like:

   ```bash
   DATABASE_URL=postgresql://wheel:wheel@localhost:5432/the_wheel
   DATABASE_SSL=false
   ```

3. Apply the Postgres migration:

   ```bash
   psql "$DATABASE_URL" -f db/migrations/0001_postgres_auth_schema.sql
   ```

4. Run the app:

   ```bash
   npm run dev
   ```

5. Open `http://localhost:3000`.

6. Create an account on the login screen. Passwords are hashed with Node `crypto.scrypt`; browser sessions are stored in the `app_sessions` table and sent as an http-only `wheel_session` cookie.

If the login screen does not appear locally, check `.env.local`. `LOCAL_DEV_AUTH_EMAIL` only auto-signs you in when `LOCAL_DEV_AUTH_AUTO_LOGIN=true`; otherwise the app shows the normal Postgres login form.

## Postgres migration handoff

1. Remove the old Supabase environment variables from `.env.local`.
2. Add `DATABASE_URL` and `DATABASE_SSL`.
3. Run `npm install` so `pg`, `@types/pg`, and `package-lock.json` are in sync.
4. Run `psql "$DATABASE_URL" -f db/migrations/0001_postgres_auth_schema.sql`.
5. Start with `npm run dev`, register the first user, then use Activity -> Sync to write SnapTrade account snapshots and positions to Postgres.
6. The relevant auth files are `lib/postgres/auth.ts`, `lib/postgres/client.ts`, and `app/api/auth/*/route.ts`.
7. The relevant data files are `lib/data.ts` and `app/api/snaptrade/sync/route.ts`.

## Important routes

- `/api/auth/register`
- `/api/auth/login`
- `/api/auth/logout`
- `/api/yahoo/quote?ticker=AAPL`
- `/api/yahoo/options?ticker=AAPL`
- `/api/snaptrade/login`
- `/api/snaptrade/sync`

All broker credentials and Yahoo calls stay on the server side, so the browser no longer needs CORS proxy workarounds.
