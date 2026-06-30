# The Wheel Web App

This repo now includes a Next.js 14 web version of the original Tkinter Treasury Wheel app.

## Stack

- Frontend: Next.js 14 App Router and TailwindCSS
- Database/Auth: Supabase Postgres and Supabase Auth
- Deployment: Vercel
- Finance APIs: server-side Next API routes for Yahoo Finance and SnapTrade

## Local setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create `.env.local` from `.env.example` and fill in Supabase and SnapTrade values.

3. Apply the Supabase migration in `supabase/migrations/0001_initial_schema.sql`.

4. Run the app:

   ```bash
   npm run dev
   ```

5. Open `http://localhost:3000`.

## Important routes

- `/api/yahoo/quote?ticker=AAPL`
- `/api/yahoo/options?ticker=AAPL`
- `/api/snaptrade/login`
- `/api/snaptrade/sync`

All broker credentials and Yahoo calls stay on the server side, so the browser no longer needs CORS proxy workarounds.
