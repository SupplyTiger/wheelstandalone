# The Wheel — CSP Screener (v1 rebuild)

Replacement for the broken `wheelstandalone-dun.vercel.app` CSP screener. That app's
`/api/yahoo/options` route was shelling out to a `python3` subprocess (running `yfinance`)
from a Node serverless function — which has no Python interpreter at all — so every
request 500'd with `spawn python3 ENOENT`, and every ticker showed `-100 / AVOID`.

This is a from-scratch rebuild, pure TypeScript, no subprocesses, **no API keys**:

- **Options chain, bid/ask, open interest, IV, underlying price, daily bars** —
  [`yahoo-finance2`](https://github.com/gadicc/yahoo-finance2), a maintained pure-JS
  reimplementation of the Yahoo endpoints `yfinance` wraps. Free, no signup, no key.
- **Earnings date** — same package, `calendarEvents` module.
- **Max pain** — standard formula, ported from `lib/maxPain.ts` in your desktop repo's
  `treasury-wheel-mobile` scaffold (unit-tested, unchanged).
- **Pre-trade gates** — Max Pain, Rule 6 (red day = sell puts), Earnings (7-day blackout),
  15% Max-Collateral Cap, 30% Concentration — ported/extended from the same scaffold's
  `lib/gates.ts`.
- **RSI(14) + divergence** — new. Flags bullish/bearish regular divergence between price
  swing points and RSI swing points over a trailing window. It's a signal column, not a
  blocking gate.

## Why this data source, and not Massive or Alpaca

Both were considered and dropped:

- **Massive** — your desktop app's own handoff log confirms the current Massive key
  returns HTTP 403 entitlement failures on live quotes at the free tier. Dead end.
- **Alpaca** — your team already validated Alpaca's free "indicative" options feed works
  for this exact use case (`wheel_alpaca.py`, July 2026), and Alpaca's docs confirm that
  feed is genuinely free ($0/mo). It's a solid option if you want it later. But it needs
  `ALPACA_KEY`/`ALPACA_SECRET`, which weren't available when this was built, so v1 uses
  the zero-setup path instead.

**One real tradeoff to know about:** `yahoo-finance2` scrapes Yahoo's own (undocumented,
unofficial) endpoints via a cookie/session bootstrap. Yahoo has changed that mechanism
before, which has broken the package for stretches until it's patched (this is a known,
recurring characteristic of the project, visible in its GitHub issues) — it is not an
official, SLA-backed API. If the screener ever starts erroring on everything at once with
a message like *"no set-cookie header"* or *"crumb"*, that's this failure mode — check the
package's GitHub issues/releases, `npm update yahoo-finance2` usually fixes it fast since
it's actively maintained. That's the cost of "free and zero setup." If that trade stops
being worth it, Alpaca (above) is the fallback path — the code that called it is still in
git history from this build if you want it back.

## Why per-ticker errors, not a blanket failure

The old desktop app's own postmortem (`CODEX-BRIEF-csp-screener.md`) documented a bug
where a catch-all error message lied about why a ticker was skipped. This rebuild never
does that: each ticker's chain fetch, bars fetch, and earnings fetch are wrapped
independently (per-call timeouts, `Promise.allSettled`), so one ticker's data problem
never blanks the whole screener, and the `Reason` column always shows the real cause.

## Setup

```bash
npm install
npm run dev                  # http://localhost:3000
```

No `.env` file needed for v1 — there is nothing to configure.

### Verifying it's live before deploying

```bash
npm run test     # unit tests: max pain, all 5 gates, RSI/divergence — no network needed
npm run build     # production build / typecheck
npm start
# then hit:
curl "http://localhost:3000/api/screener?tickers=AAPL,MSFT&dteMin=7&dteMax=60"
```

**Important — this was never verified against live data end-to-end.** My build
environment's network is sandboxed and can't reach `query1/2.finance.yahoo.com` at all
(confirmed: the egress proxy here returns a fast 403 for that host, same as it did for
Massive and Alpaca). Everything that doesn't require live network — max pain math, all 5
gates, RSI/divergence detection — is unit-tested and passing (12/12). The live data path
needs to be run once from a normal network (your machine, or after deploying) before you
trust it. If it errors, the `Reason` column in the UI (and the API's `skipReason` field)
will say exactly why per ticker — it won't silently show -100/AVOID like the old app did.

## Deploying

1. Push this to a new GitHub repo (or `vercel deploy` directly from this folder with the
   Vercel CLI).
2. No environment variables required.
3. Deploy, then run the screener against a couple of tickers you know have listed options
   (e.g. AAPL, SOFI) and check the `Reason` column for any per-ticker errors.

## What's deliberately NOT in here yet

Per your instruction to keep this v1 scoped: no IV rank, no "Wall support" detection, no
Theta Sniper auto-flagging, no account/position integration, no delta filtering (Yahoo's
options data gives implied volatility but not delta/gamma/theta out of the box). RSI < 35
and bullish divergence contribute to the candidate score but are not blocking gates — only
your five mandate rules (Max Pain, Rule 6, Earnings, 15% cap, 30% concentration) block a
verdict. Add features one at a time from here rather than all at once — that's what broke
the desktop version.

## File map

```
lib/
  gates.ts        — the 5 pre-trade checklist gates + verdict logic (unit tested)
  maxPain.ts       — max pain calculation (unit tested)
  yahooMarket.ts   — options chain, underlying price, daily bars (yahoo-finance2)
  earnings.ts      — next earnings date (yahoo-finance2, non-fatal, 8s timeout)
  technicals.ts    — RSI(14) + divergence detection (unit tested)
  screener.ts      — orchestrator: runs all of the above per ticker, scores, sorts
  __tests__/       — node:test unit tests, no network required
app/
  page.tsx         — screener UI (watchlist, DTE/ROI filters, candidates table)
  api/screener/route.ts — GET endpoint the UI calls
```
