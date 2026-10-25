# PMCC screener — `/api/pmcc-screener`

A diagonal-spread screen: a deep ITM long LEAPS call (surrogate shares) plus a
short-dated short call sold against it. Read-only, never trades, never verifies
a fill. Deployed to production Oct 2026 (PR #4, main `dc73cbdc`); chains now
come from the market-data stack — see `docs/market-data-stack.md`.

## Route contract

`GET /api/pmcc-screener?tickers=META,NVDA&...` — same shape and discipline as
`/api/screener`:

| Param | Default | Meaning |
|---|---|---|
| `tickers` | (required) | Max 40, deduped, same ticker regex as the CSP route. |
| `leapsDteMin` / `leapsDteMax` | 365 / 730 | LEAPS expiry window (12–24 months). |
| `shortDteMin` / `shortDteMax` | 30 / 45 | Short-leg expiry window. |
| `leapsDeltaMin` / `leapsDeltaMax` | 0.70 / 0.90 | LEAPS delta band. The cap is load-bearing (see below). |
| `shortDeltaMin` / `shortDeltaMax` | 0.20 / 0.30 | Short-leg delta band (absolute values). |
| `minPremiumShare` | 2 | Short credit as % of LEAPS debit required for `ready` (below = `watch`). |
| `maxSpreadPct` | 30 | Max (ask-bid)/mid % for either leg; wider = tossed, never scored. |
| `longDebit` | — | Per-share debit actually paid for an existing long (Width Rule basis). |
| `zThreshold` | 2 | \|robust z\| at/above this flags an outlier. |
| `accountValue` | 200000 | Headline total for the %-of-account gates. |
| `account` / `freeCash` / `reserved` / `positions` | — | Per-account context, exactly as on `/api/screener`. Malformed `positions` → HTTP 400, never a silent fallback. |

Response: `scannedAt`, `accountContext` echo (null when position-blind),
`dataNote`, `results` (one row per ticker), `metrics` (population n + median
per metric), `summary` (scanned/ready/watch/avoid/errors/outliers).

Two chain fetches per ticker (one per window), so keep universes modest — ~10
tickers per call stays inside the route's 60s limit; chunk larger universes.

## Modes (per ticker)

- **fresh** — no long call held: screen LEAPS + short pairs from scratch. The
  LEAPS pick is the lowest extrinsic-value-per-delta candidate inside the
  delta band (cheapest surrogate shares).
- **existing-long** — the position context holds a long call on the ticker
  (e.g. META Jan'28 $750C): screen NEW short legs against that actual long.
  The Width Rule basis prefers `longDebit` when passed, else the chain mid of
  the held long, else the rule is reported `unknown` and the row caps at
  `watch`. A held long outside the LEAPS window (decayed) still screens — its
  own strike/expiry are used, not the window's.

## Gates (all hard blocks except where noted)

- **Width Rule** — short strike >= LEAPS strike + net debit per share. Enforced
  at selection (ineligible shorts never become candidates) and re-checked as a
  gate. A short below the floor caps upside below breakeven — not a PMCC.
- **Covered only** — long strike <= short strike and long expiry after short
  expiry; a second short on a ticker that already has one is blocked ("the
  long covers one short only, no doubling"). The block fires even when no new
  short clears the floor, so a long + open short never looks like a bare long.
- **Never across earnings** — earnings inside the short leg's life blocks it.
- **Rule 6, call side** — short calls sell on green days only.
- **Concentration** — the LEAPS value counts toward the ticker's 30% cap
  (same wording as the CSP gate; implemented locally in `lib/pmcc.ts` because
  the shared gate's input type carries CSP fields a PMCC structure doesn't
  have — passing fabricated values to satisfy the type would be a lie).
- **No margin** — a fresh LEAPS debit must fit inside reported free cash.
  Position-blind calls skip this gate (unknown cash never passes or fails).
- **21-DTE time stop** — management flag, not a block: an existing short
  inside 21 DTE is flagged for closing per rule.
- **Long never sold while a short is open** — flagged on every structure.

Status: `ready` = approved and premium share >= `minPremiumShare` and Width
Rule verified; `watch` = approved but thin premium or unverified width basis;
`avoid` = blocked or skipped (no candidate, with the real reason).

## The outlier engine (the core ask)

`lib/outliers.ts` knows nothing about options. It takes any items and any
metric definitions, measures each item against the population on each metric
with a **robust z-score** (median + MAD, falling back to mean absolute
deviation when MAD is 0 — otherwise a majority-identical population would
never flag), and flags |z| >= `zThreshold`.

**Adding a metric is one array entry** in `PMCC_METRICS` (`lib/pmcc.ts`):
`{ key, label, get, good }`. No change to the engine, the route, or the
response shape. That is Ryan's "X, Y, or Z" requirement, implemented literally.

Current metrics (all four are required, none optional):

| Metric | Good side | What it catches |
|---|---|---|
| `ivTermSpread` — short IV minus LEAPS IV (pp) | high | Rich short leg vs cheap long leg = the diagonal-spread edge. |
| `shortAnnYield` — premium vs LEAPS debit, annualized | high | Short legs paying far above the pack. |
| `leapsExtrinsicPerDelta` — LEAPS extrinsic per delta | low | Expensive surrogate shares (high = overpaying for time value). |
| `callPutSkew` — call IV minus put IV, same strike/expiry | either | A dislocation in either direction — pure oddity, not good/bad. |

A flag is NOT a verdict: it says "far from its peers, look at it." The flag's
`direction` vs its metric's `good` side tells you whether the extreme is
favorable (e.g. NFLX cheap LEAPS, low extrinsic) or adverse (e.g. META
expensive LEAPS, high extrinsic). Wide bid-ask spreads are a FILTER, not a
flag: unquotable legs are tossed even when the numbers look great.

## Why the LEAPS delta cap exists

Ranking by lowest extrinsic-per-delta without an upper delta bound
degenerates: a $5 strike on a $650 stock has delta 0.999 and near-zero
extrinsic, so it "wins" while being the stock itself with extra steps — and
its Yahoo IV is meaningless (spreads like -228pp in testing). The 0.90 cap
keeps LEAPS in the genuine 0.70–0.90 surrogate-shares band. If Ryan wants a
different band, it's the `leapsDeltaMax` param, not a code change.

## Data honesty

Yahoo IV and delta are model outputs computed here from Yahoo's IV
(`lib/blackScholes.ts`, call delta = put delta + 1 by put-call parity), not
exchange quotes. Chains can be stale; Saturday runs read Friday's tape (so
green-day blocks reflect Friday). The response's `dataNote` says this on every
call. Candidates only — never a fill verification, never a trade.

## What is NOT here (yet)

- No UI tab. `app/page.tsx` has a fixed 5-tab layout and `PlaceholderTab` is
  a generic stand-in; a real PMCC tab (fetch + table + flag rendering) is a
  separate piece of scope. The natural mount is a new tab alongside Screener,
  or the Action Center tab once it is rebuilt.
- No app-side Plaid: the route takes the same caller-passed context as the
  CSP route. No tokens live in this app, and SnapTrade is not used anywhere.
- No order/trade code, no margin assumptions, no env changes.

## Worked example (live Yahoo chains, Oct 24 2026)

- META existing-long (Jan'28 $750C, caller debit $148.44): no 30–45 DTE call
  with delta 0.20–0.30 clears the $898.44 Width Rule floor from spot $642.62
  — the screen correctly offers nothing rather than a bad short.
- META long + existing Mar'27 $850C short: BLOCKED with the doubling reason,
  even though no new short clears the floor (the run-B fix).
- Fresh 12-name universe, Prime context: 10 structures, 0 ready — every one
  blocked by real reasons (Friday's red tape on green-day, earnings inside
  short lives, LEAPS debits vs $2,958.27 free cash). Outlier flags still fired
  (AMD rich term spread, META/AMD expensive LEAPS, NFLX cheap LEAPS, AAPL
  compressed term spread). Position-blind, the same universe loses only the
  free-cash blocks — AVGO/UNH/NFLX sit one green day from `ready`.
