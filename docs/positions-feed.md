# Positions feed: Plaid in, SnapTrade out, screener position-aware

## The problem this solves

The CSP screener used to take a single `accountValue` and knew nothing about
the account behind it. It could APPROVE a CSP on an underlying the account
was already short a put on, and it sized collateral against the headline
account total while only a fraction of that cash is free. The output was not
actionable without manual reconciliation against the real book. That is what
changed: the screener now accepts one account's position context and filters
against it.

## SnapTrade: removed from the app's path

- An older read-only SnapTrade integration exists only on the unmerged
  `feature/portfolio-api` branch (GET-only, hand-signed HMAC, no order code),
  exposing `/api/portfolio` on a preview deployment. It was never merged to
  production `main`, which never contained any SnapTrade code.
- That branch is left untouched — not merged, not deleted. Nothing in this
  app reads from it, and no tracked file in this repo references SnapTrade
  anymore (code comments updated 2026-10-24). Note: the Oct 7 workspace
  investigation note that once named SnapTrade as a feed option
  (STATUS-2026-10-07.md) was never part of this repo's tracked tree, so it
  is not pushed here — it stays a local-only record, and this doc is the
  repo's superseding record.
- SnapTrade is not revived here because it is no longer needed: Plaid now
  provides the same read-only book, with per-account separation, and no
  deploy or credential work is required to use it.

## Architecture decision: Muse-published context (params), not app-side Plaid

Two designs were on the table. The one implemented is (b); (a) is documented
below as a future path, not built.

### (b) IMPLEMENTED — Muse passes per-account context as screener params

Flow:

1. Muse runs `scripts/refresh-positions-by-account.mjs` from its own Plaid
   connection. Output: `public/positions-by-account.json` — every linked
   investment account with its positions, total value, free cash
   (Plaid-reported available balance), and already-reserved put capital.
   The script prints ready-to-paste screener params per account.
2. Muse calls `/api/screener` once per account with that account's context:
   `account`, `accountValue` (headline total, for the existing %-of-account
   gates), `freeCash`, `reserved`, and `positions` (JSON array).
3. The screener filters that account's candidates against its own book
   (details below) and echoes the context back in `accountContext`.

Why this won:

- **No tokens in the app.** Muse's Plaid connection tokens are not
  exportable and are never copied anywhere. The app holds zero credentials
  for this feature.
- **No deploy or credential work for Ryan.** Nothing to create, link, or
  rotate. The feature works the moment this branch deploys.
- **Privacy.** This repo is public. Live positions are never committed:
  both feed files are gitignored, and the screener's awareness travels as
  query params at call time, not as a file in git. A git-based deploy
  contains no live book; the screener then behaves exactly as before
  (position-blind) unless the caller passes context.
- **Backward compatible.** Calls without the new params behave identically
  to the old screener — same gates, same verdicts. The new checks only
  apply when context is present.

### (a) NOT BUILT — app-side Plaid (future path, only if the app itself must be position-aware)

If a future decision wants the deployed app to know the book on its own
(without Muse passing context), that needs a Plaid integration owned by the
app, not by Muse. Nothing in (b) blocks it, but it is real work Ryan must
do himself — it cannot be done from here:

1. Ryan creates a Plaid developer app (dashboard.plaid.com) and a Link flow,
   completes Link for the Fidelity item, and exchanges the public token for
   an access token (Plaid's `/item/public_token/exchange`).
2. Ryan sets that access token as a Vercel env var on the project
   (suggested name: `PLAID_ACCESS_TOKEN`, production scope only) and
   redeploys. No token is ever committed to git.
3. Then a new read-only route (suggested: `/api/positions`) can be built on
   Plaid's `/investments/holdings/get`, returning the same per-account
   shape as `positions-by-account.json`, and the screener route can accept
   an `account` name and load that route's output server-side.
4. Until steps 1–2 are done, (a) cannot function — a route without a token
   would only return an honest error state, so it is deliberately not
   shipped half-wired.

## What the screener does with context (per account)

All existing gates are untouched and run first (Max Pain, Rule 6 red-day,
7-day earnings blackout, 15% max-collateral cap, 30% concentration,
0.30 delta filter — six gates for a put; calls add capital defense and the
naked ban). Context adds, only when present:

1. **Duplicate-short block (hard BLOCK).** If the account already holds a
   short put on the candidate's ticker — any strike, any expiry — the
   candidate is BLOCKED with reason "Already short a {TICKER} put in this
   account … — one short put per underlying, no doubling", and the row
   carries `alreadyShortPut: true`. Wheel rule: assignment risk stacks if
   you double an underlying. (The positions param carries strike/expiry,
   so narrowing this to same-expiry later is a one-line change if Ryan
   ever wants it.)
2. **Free-cash gate (hard BLOCK).** The new CSP's full strike x 100
   collateral must fit inside the account's reported free cash. If not:
   "CSP needs $X collateral but free cash is $Y — cash-secured only, no
   margin". This is the no-margin rule enforced in code: margin borrowing
   is never assumed to fund a trade.
3. **Concentration counts the existing book.** The 30% concentration gate
   previously counted only the new trade (`currentTickerValue` was hardcoded
   0). With context it counts existing exposure to that ticker: shares held
   (market value) plus capital already reserved by short puts on it.
4. **Echo.** The response carries `accountContext` (account, accountValue,
   freeCash, reservedCollateral, positionCount) and each row carries
   `existingTickerValue` (null without context), so a caller can verify
   what the scan was filtered against.

The 15% max-collateral cap still runs against the headline account total,
exactly as before — the free-cash gate is additional, not a replacement.
Both must pass.

## Param contract

```
GET /api/screener?tickers=APP,META,AMZN&dteMin=21&dteMax=45&minRoi=1
  &excludeEarningsDays=7&accountValue=83275
  &account=Prime%20Printer&freeCash=2958.27&reserved=28000
  &positions=<urlencoded JSON array>
```

`positions` entries: `{ticker, kind: "put"|"call"|"stock", side: "short"|"long",
quantity?, strike?, expiry?, marketValue?}`. Tickers are uppercase
letters/digits/dots/dashes (same validation as the tickers param). Max 100
entries, max 8192 characters. A malformed `positions` value is HTTP 400 —
never a silent fallback to position-blind, because claiming awareness on a
broken book would be worse than none. Invalid `freeCash`/`reserved` degrade
to unknown (gate skipped), never to an invented number.

## Reference book (Oct 24, 2026, Plaid — for testing, not committed)

- Prime Printer …5767: total $83,275.27, free cash $2,958.27, reserved put
  capital $28,000 (short APP Nov 20 $280P x1). Also short META Mar'27 $850C
  and AMZN Nov 20 $260C; long AMZN 100, SPCX 100, META/NVDA calls.
- IRA Wheel …8749: total $29,032.77, free cash $1,136.11, no short puts.
- MidKnight …3955: total $4,809.57, free cash $322.56, no options.

Consequences a test must show: an APP CSP is blocked for Prime (duplicate
short put + free-cash + concentration) but not flagged for IRA on the
duplicate rule; AMZN at accountValue 83275 still blocks on 28.2% collateral
and the earnings blackout, exactly as the position-blind probe did.

## Files

- `lib/positions.ts` — pure position-context logic (parse, duplicate-short,
  exposure, reserved capital, free-cash gate). Unit-tested.
- `lib/screener.ts` — wires context into candidate evaluation + response.
- `app/api/screener/route.ts` — parses the new params (400 on bad positions).
- `scripts/refresh-positions-by-account.mjs` — multi-account Plaid feed.
- `scripts/refresh-positions.mjs` — the older single-account Positions-tab
  script got the same partial-read fix (it previously discarded good data
  whenever any institution failed, because the CLI exits nonzero on partial
  reads while still printing valid JSON).
- `scripts/full-scan.ts` — batch-failure fallback rows carry the two new
  row fields (typecheck only; no logic change).
- `docs/positions-feed.md` — this file.
