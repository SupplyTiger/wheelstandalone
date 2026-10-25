# Market-data stack — how the PMCC screener gets its chains

## The problem it solves

Production `/api/pmcc-screener` returned honest Yahoo skips ("No option
chain returned by Yahoo") while `/api/screener` worked from Vercel seconds
apart. Diagnosis: Yahoo throttling Vercel's shared egress, worsened by the
PMCC route firing two chain-window fetches + bars + earnings concurrently
per ticker, and all tickers concurrently. The route failed closed (offered
nothing, said so) — correct, but useless.

## The stack, in priority order

Every PMCC chain window walks these layers in order and stops at the first
one that returns a chain. The winning layer is named on every row
(`chainSource`: `yahoo` | `cboe` | `tradier` | `mixed` | null), and
earlier layers' errors ride along in `sourceErrors`.

### Layer 1 — Yahoo, resilient (no new accounts, no new keys)

`lib/yahooMarket.ts` (existing `fetchOptionsSummary` untouched) plus a new
resilient wrapper, `fetchOptionsSummaryResilient`:

- Retry with exponential backoff + jitter (600ms, 1800ms, 3 attempts).
- A 5-minute in-memory chain cache with request coalescing: the same
  ticker+window is fetched once per window, and concurrent callers share
  the in-flight promise. Serverless note: the cache lives per function
  instance — best effort, not a guarantee — but it still kills duplicate
  fetches inside one scan. Failures are never cached.
- The PMCC route now screens tickers SEQUENTIALLY and fetches each
  ticker's windows/bars/earnings sequentially. Slower per scan, but a
  burst is exactly what got throttled. Keep universes modest (~10 tickers
  per call stays inside the route's 60s limit).

The CSP route does NOT use any of this: it still calls
`fetchOptionsSummary` directly, byte-identical behavior, proven by the
unchanged blind-AMZN check (BLOCKED on the 28.2% collateral cap + 5 DTE
earnings blackout).

### Layer 2 — CBOE delayed quotes (no signup, no key) — LIVE AND WORKING

`lib/cboe.ts` — CBOE's own delayed-quotes JSON feed
(`cdn.cboe.com/api/global/delayed_quotes/options/{SYMBOL}.json`), ~15
minutes delayed. Verified live Oct 2026: one request returns the full
chain (7,322 META contracts, expiries Oct 2026 through Jan 2029), each
contract carrying bid, ask, IV, delta, gamma, vega, theta, rho, open
interest, volume, and last trade price, plus an underlying block with
current price and day change. That covers everything the screener needs,
so the mapping is complete. The screener still computes delta from IV
via Black-Scholes for consistency; CBOE's own delta is ignored so one
code path scores every row regardless of source.

Honest limits: this is CBOE's website feed, not a documented API — the
URL shape can change without notice. If it 404s or reshapes, the stack
treats it like any other source failure. Deep-ITM far-expiry IVs can be
absurd (the LEAPS 0.90 delta cap already handles that class), and
last-trade prices can be days stale (the screener prices off bid/ask
mids, never off last).

The old `markets.cboe.com/json/delayed_quotes/table/{symbol}/` endpoint
is DEAD (307 to a 404 page) — do not revive it; the `cdn.cboe.com` API
above is the working one.

### Layer 3 — Tradier sandbox (code-ready, DORMANT without a token)

`lib/tradier.ts` — Tradier's free developer sandbox (no brokerage
account required, REST, ~15-minute delayed chains with basic Greeks).
The adapter reads its token ONLY from the `TRADIER_SANDBOX_TOKEN` env
var. Without a token the leg stays dormant: no call is made, no token
is faked, and the stack records "dormant" instead of an error so a
reader can tell "not configured" apart from "tried and failed".

IV mapping note (provisional): Tradier's greeks IV is read as mid_iv,
else bid_iv, else ask_iv, else iv, per Tradier's public REST docs. If
the live shape differs, the first live-token run will show it at once
(IVs come back null and the screener's delta path reports it), and the
mapping gets corrected then. Nothing invents an IV: null stays null.

## What Ryan must do (the ONLY step this stack needs from him)

For the Tradier leg, and ONLY the Tradier leg — Layers 1 and 2 need
nothing from him:

1. Sign up free at tradier.com.
2. Open API Access -> Sandbox Account Access and generate a sandbox
   access token.
3. Set it as a Vercel env var named `TRADIER_SANDBOX_TOKEN`
   (production scope) on the wheelstandalone project, then redeploy.

No brokerage account, no funding, no live trading. The sandbox serves
delayed data only — exactly what a screener needs. Until the token
exists, Tradier is tested with mocked responses only; live Tradier
verification waits on the token.

## Delayed-data statement (not hidden)

All three layers are screening-grade data. Yahoo is the freshest;
CBOE and Tradier are ~15 minutes delayed. That is fine for a screener
— candidates for Ryan's review, never a fill verification, never a
trade — and the response's `dataNote` says so on every call.

## Failure contract

On total failure the route's row carries ONE skip reason naming all
three sources' errors (e.g. `short window: All chain sources failed
for META — yahoo: ... | cboe: ... | tradier: ...`). A bare "No option
chain" with no cause is a bug now, not a status.
