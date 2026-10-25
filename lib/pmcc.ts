// PMCC (poor man's covered call) screener orchestrator.
//
// WHAT THIS IS: a diagonal-spread screen. Each candidate structure is a deep
// ITM long LEAPS call (surrogate shares) plus a short-dated short call sold
// against it. Two modes, per ticker:
//   - "fresh": no long call held — screen LEAPS + short pairs from scratch.
//   - "existing-long": the account already holds a long call (passed via the
//     position context, e.g. META Jan'28 $750C) — screen NEW short legs against
//     that actual long, with Ryan's Width Rule applied to it.
// The route is read-only and never trades: it flags candidates for Ryan's
// review. It never verifies a fill and never places an order.
//
// STANDING PMCC RULES ENFORCED HERE (from the wheel mandate + Ryan's calls):
//   - Width Rule: short strike >= LEAPS strike + net debit. A short below the
//     floor caps upside below breakeven — not a valid PMCC, hard block.
//   - Covered only: the long must cover the short (long strike <= short strike,
//     long expiry after short expiry). A second short on a ticker that already
//     has one is blocked — one long covers one short, no doubling.
//   - Never across earnings: earnings inside the short leg's life blocks it.
//   - Green-day gate: short calls sell on green days only (Rule 6, call side).
//   - 21-DTE time stop: a management flag, not a screen block — an existing
//     short inside 21 DTE gets flagged for closing per rule.
//   - Concentration: the LEAPS value counts toward the ticker's 30% cap.
//   - No margin: a fresh LEAPS debit must fit inside reported free cash.
//   - Long never sold while a short is open (flagged on every structure).
//
// DATA HONESTY: Yahoo IV and delta are model outputs computed here from Yahoo's
// IV (see lib/blackScholes.ts), not exchange quotes. Chains can be stale and
// wide; the spread filter tosses unquotable legs rather than scoring them.
// The response carries a dataNote saying exactly this.
//
// OUTLIER ENGINE: see lib/outliers.ts. The metric registry below is the only
// place PMCC metrics live — adding a metric is ONE array entry (Ryan's "X, Y,
// or Z" requirement). Flags highlight; they never block. A "ready" structure
// with outlier flags is the point of the screen: an extreme worth a look.

import { fetchDailyBars, type DailyBar, type NormalizedContract } from "./yahooMarket";
import { fetchChainStack, type ChainSource } from "./marketData";
import { fetchNextEarningsDate } from "./earnings";
import { callDelta } from "./blackScholes";
import { checkRule6Gate, currency, type MarketDirection } from "./gates";
import {
  findLongCall,
  findShortCall,
  tickerExposure,
  type AccountContext,
} from "./positions";
import { computeOutlierFlags, metricPopulations, type MetricDef, type OutlierFlag } from "./outliers";
import { MIN_BID } from "./screener";

export type PmccParams = {
  tickers: string[];
  leapsDteMin: number;
  leapsDteMax: number;
  shortDteMin: number;
  shortDteMax: number;
  leapsDeltaMin: number;
  /**
   * Upper end of the LEAPS delta band. REQUIRED, not a nicety: ranking by
   * lowest extrinsic-per-delta without a cap degenerates — a $5 strike on a
   * $650 stock has delta 0.999 and near-zero extrinsic, so it "wins" while
   * being the stock itself with extra steps (and its Yahoo IV is meaningless).
   * 0.90 keeps LEAPS in the genuine surrogate-shares band.
   */
  leapsDeltaMax: number;
  shortDeltaMin: number;
  shortDeltaMax: number;
  /** Short credit as % of LEAPS debit required for "ready" (below = "watch"). */
  minPremiumSharePct: number;
  /** Max (ask-bid)/mid % for either leg; wider = tossed, not scored. */
  maxSpreadPct: number;
  accountValue: number;
  accountContext?: AccountContext | null;
  /**
   * Per-share debit actually paid for an existing long, when the caller knows
   * it (e.g. META Jan'28 $750C cost basis). Beats the chain-mid proxy as the
   * Width Rule basis. Absent = chain mid of the long, if quotable.
   */
  longDebitPerShare?: number | null;
  /** |robust z| at/above this flags an outlier (default 2). */
  zThreshold: number;
};

export type PmccStatus = "ready" | "watch" | "avoid";

export type PmccCandidateRow = {
  ticker: string;
  status: PmccStatus;
  verdict: "APPROVED" | "BLOCKED" | null;
  price: number | null;
  dayChangePct: number | null;
  mode: "fresh" | "existing-long";
  leapsStrike: number | null;
  leapsExpiry: string | null;
  leapsDte: number | null;
  leapsMid: number | null;
  leapsDebit: number | null;
  leapsDelta: number | null;
  leapsIv: number | null;
  leapsExtrinsic: number | null;
  leapsExtrinsicPerDelta: number | null;
  shortStrike: number | null;
  shortExpiry: string | null;
  shortDte: number | null;
  shortMid: number | null;
  shortCredit: number | null;
  shortDelta: number | null;
  shortIv: number | null;
  premiumSharePct: number | null;
  annYieldPct: number | null;
  ivTermSpreadPp: number | null;
  callPutSkewPp: number | null;
  widthFloor: number | null;
  widthRule: "pass" | "fail" | "unknown";
  widthBasis: "leaps-mid" | "caller-debit" | "chain-mid" | "unknown";
  daysToEarnings: number | null;
  blockReasons: string[];
  skipReason: string | null;
  /** Management notes: 21-DTE stop, long-never-sold, approximations used. */
  managementFlags: string[];
  outlierFlags: OutlierFlag[];
  isOutlier: boolean;
  existingTickerValue: number | null;
  /** Which chain layer won ("mixed" when the two windows came from different
   * sources, null when no chain was fetched). Delayed layers are named,
   * never hidden: a "cboe"/"tradier" row is ~15 minutes delayed. */
  chainSource: ChainSource | "mixed" | null;
  /** Earlier layers' error messages for the winning chains, plus the fatal
   * errors when a window failed outright. Empty = Yahoo won cleanly. */
  sourceErrors: string[];
};

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in lib/__tests__/pmcc.test.ts).
// ---------------------------------------------------------------------------

export function daysToExpiry(expiry: string): number | null {
  const d = new Date(`${expiry}T20:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  return Math.max(0, Math.round((d.getTime() - Date.now()) / 86_400_000));
}

export function midPrice(bid: number | null, ask: number | null): number | null {
  if (bid !== null && bid > 0 && ask !== null && ask >= bid) return Number(((bid + ask) / 2).toFixed(2));
  return null;
}

/** Spread as % of mid; null when the quote isn't two-sided. */
export function spreadPct(bid: number | null, ask: number | null): number | null {
  const mid = midPrice(bid, ask);
  if (mid === null || mid <= 0 || ask === null || bid === null) return null;
  return ((ask - bid) / mid) * 100;
}

/** Width Rule floor: the short strike must sit at or above this. */
export function widthFloor(leapsStrike: number, debitPerShare: number): number {
  return Number((leapsStrike + debitPerShare).toFixed(2));
}

/**
 * Concentration block, mirroring the wheel's 30% cap (same wording as the
 * gates.ts version): existing ticker value + new capital vs account value.
 * Kept local instead of reusing checkConcentrationGate because that gate's
 * input type carries CSP fields (kind, strike, max pain) a PMCC structure
 * doesn't have — passing fabricated values to satisfy the type would be a lie
 * in the object. The rule itself is identical.
 */
export function concentrationBlock(
  ticker: string,
  accountValue: number,
  currentTickerValue: number,
  newCapital: number,
): string | null {
  if (accountValue <= 0) return null;
  const pct = ((currentTickerValue + newCapital) / accountValue) * 100;
  if (pct > 30) {
    return `${ticker.toUpperCase()} would be ${pct.toFixed(1)}% of portfolio (30% limit)`;
  }
  return null;
}

/**
 * Skip reason when BOTH chain windows fail — with the underlying errors
 * attached, not a bare "No option chain". The old message hid whether
 * Yahoo throttled, CBOE reshaped, or Tradier was dormant; this one names
 * it. Pure and unit-tested.
 */
export function chainSkipReason(shortError: string | null, leapsError: string | null): string {
  const parts: string[] = [];
  if (shortError) parts.push(`short window: ${shortError}`);
  if (leapsError) parts.push(`LEAPS window: ${leapsError}`);
  const detail = parts.length ? ` (${parts.join("; ")})` : "";
  return `No option chain returned for the short or LEAPS window${detail}`;
}

/** Short-leg annualized yield: premium vs LEAPS debit, annualized. */
export function annualizedYield(credit: number, leapsDebit: number, shortDte: number): number | null {
  if (leapsDebit <= 0 || shortDte <= 0) return null;
  return Number((((credit / leapsDebit) * 365) / shortDte * 100).toFixed(1));
}

// ---------------------------------------------------------------------------
// Outlier metric registry — THE one-line-per-metric list. Each entry is a
// metric the engine measures against the screened population and flags at
// |robust z| >= zThreshold. To add Ryan's next X, Y, or Z: append one entry.
// ---------------------------------------------------------------------------

export const PMCC_METRICS: Array<MetricDef<PmccCandidateRow>> = [
  {
    key: "ivTermSpread",
    label: "IV term-structure spread (short IV minus LEAPS IV)",
    get: (r) => r.ivTermSpreadPp,
    good: "high", // rich short leg vs cheap long leg = the diagonal-spread edge
  },
  {
    key: "shortAnnYield",
    label: "Short-leg annualized yield vs LEAPS debit",
    get: (r) => r.annYieldPct,
    good: "high",
  },
  {
    key: "leapsExtrinsicPerDelta",
    label: "LEAPS extrinsic value per point of delta",
    get: (r) => r.leapsExtrinsicPerDelta,
    good: "low", // cheaper surrogate shares = less time value paid per delta
  },
  {
    key: "callPutSkew",
    label: "Call-put IV skew at the short strike/expiry",
    get: (r) => r.callPutSkewPp,
    good: "either", // a dislocation in either direction is just an oddity
  },
];

// ---------------------------------------------------------------------------
// Per-ticker screen.
// ---------------------------------------------------------------------------

type LegQuote = {
  contract: NormalizedContract;
  dte: number;
  mid: number;
  delta: number;
};

async function screenOneTicker(ticker: string, params: PmccParams): Promise<PmccCandidateRow> {
  const base: PmccCandidateRow = {
    ticker, status: "avoid", verdict: null, price: null, dayChangePct: null,
    mode: "fresh", leapsStrike: null, leapsExpiry: null, leapsDte: null,
    leapsMid: null, leapsDebit: null, leapsDelta: null, leapsIv: null,
    leapsExtrinsic: null, leapsExtrinsicPerDelta: null, shortStrike: null,
    shortExpiry: null, shortDte: null, shortMid: null, shortCredit: null,
    shortDelta: null, shortIv: null, premiumSharePct: null, annYieldPct: null,
    ivTermSpreadPp: null, callPutSkewPp: null, widthFloor: null,
    widthRule: "unknown", widthBasis: "unknown", daysToEarnings: null,
    blockReasons: [], skipReason: null, managementFlags: [], outlierFlags: [],
    isOutlier: false, existingTickerValue: null, chainSource: null, sourceErrors: [],
  };

  const ctx = params.accountContext ?? null;
  const existingLong = ctx ? findLongCall(ctx.positions, ticker) : null;
  const existingShort = ctx ? findShortCall(ctx.positions, ticker) : null;
  const existingTickerValue = ctx ? tickerExposure(ctx.positions, ticker) : null;
  base.existingTickerValue = existingTickerValue;

  const shortFrom = new Date(Date.now() + params.shortDteMin * 86_400_000).toISOString().slice(0, 10);
  const shortTo = new Date(Date.now() + params.shortDteMax * 86_400_000).toISOString().slice(0, 10);
  const leapsFrom = new Date(Date.now() + params.leapsDteMin * 86_400_000).toISOString().slice(0, 10);
  const leapsTo = new Date(Date.now() + params.leapsDteMax * 86_400_000).toISOString().slice(0, 10);

  // SEQUENTIAL, not concurrent — the market-data stack's core Yahoo fix.
  // The old code fired both chain windows + bars + earnings concurrently
  // per ticker, and runPmccScreener fired all tickers concurrently: a
  // burst that Yahoo answers with throttling on shared egress. Each
  // window now walks the stack (Yahoo resilient -> CBOE delayed ->
  // Tradier sandbox) one step at a time, and each failure is kept with
  // its message instead of collapsing into a bare skip.
  let shortChain: Awaited<ReturnType<typeof fetchChainStack>>["summary"] | null = null;
  let leapsChain: Awaited<ReturnType<typeof fetchChainStack>>["summary"] | null = null;
  let shortError: string | null = null;
  let leapsError: string | null = null;
  let shortSource: ChainSource | null = null;
  let leapsSource: ChainSource | null = null;
  const stackErrors: string[] = [];
  try {
    const r = await fetchChainStack(ticker, shortFrom, shortTo);
    shortChain = r.summary;
    shortSource = r.source;
    stackErrors.push(...r.sourceErrors);
  } catch (error) {
    shortError = error instanceof Error ? error.message : "Unknown short-window chain error";
  }
  try {
    const r = await fetchChainStack(ticker, leapsFrom, leapsTo);
    leapsChain = r.summary;
    leapsSource = r.source;
    stackErrors.push(...r.sourceErrors);
  } catch (error) {
    leapsError = error instanceof Error ? error.message : "Unknown LEAPS-window chain error";
  }
  let bars: DailyBar[] | null = null;
  try {
    bars = await fetchDailyBars(ticker, 120);
  } catch {
    bars = null; // bars failing is non-fatal: direction falls back to dayChangePct
  }
  let earningsDays: number | null = null;
  try {
    earningsDays = (await fetchNextEarningsDate(ticker))?.daysToEarnings ?? null;
  } catch {
    earningsDays = null; // earnings failing is null-tolerant by design
  }

  if (shortChain === null && leapsChain === null) {
    base.skipReason = chainSkipReason(shortError, leapsError);
    base.sourceErrors = [shortError, leapsError].filter((e): e is string => e !== null);
    return base;
  }
  // Either chain may fail alone (thin name, one bad window) — the other still
  // tells us what it can; the missing leg is reported, not papered over.
  base.chainSource =
    shortSource !== null && leapsSource !== null
      ? shortSource === leapsSource
        ? shortSource
        : "mixed"
      : (shortSource ?? leapsSource);
  base.sourceErrors = stackErrors;
  const price = (shortChain ?? leapsChain)?.underlyingPrice ?? null;
  base.price = price;
  base.dayChangePct = (shortChain ?? leapsChain)?.dayChangePct ?? null;
  if (price === null) {
    base.skipReason = "No live underlying price returned";
    return base;
  }

  let marketDirection: MarketDirection = "red";
  if (bars !== null && bars.length >= 2) {
    marketDirection = bars[bars.length - 1].close >= bars[bars.length - 2].close ? "green" : "red";
    if (base.dayChangePct === null) {
      const last = bars[bars.length - 1].close;
      const prev = bars[bars.length - 2].close;
      if (prev) base.dayChangePct = ((last - prev) / prev) * 100;
    }
  } else if (base.dayChangePct !== null) {
    marketDirection = base.dayChangePct >= 0 ? "green" : "red";
  }
  const daysToEarnings = earningsDays;
  base.daysToEarnings = daysToEarnings;

  // ---- Long leg -----------------------------------------------------------
  let leaps: LegQuote | null = null;
  let leapsDebitPerShare: number | null = null;
  if (existingLong && existingLong.strike && existingLong.expiry) {
    base.mode = "existing-long";
    const leapsDte = daysToExpiry(existingLong.expiry);
    if (leapsDte === null || leapsDte <= 0) {
      base.skipReason = `Existing long call ${existingLong.expiry} is expired or unparseable — not a PMCC leg`;
      return base;
    }
    base.leapsStrike = existingLong.strike;
    base.leapsExpiry = existingLong.expiry;
    base.leapsDte = leapsDte;
    // Current quote for the held long, when the chain carries it (its expiry
    // is inside the LEAPS window for a live LEAPS; a decayed long may not be).
    const held = leapsChain?.contractsList.find(
      (c) => c.kind === "call" && c.strike === existingLong.strike && c.expiry === existingLong.expiry,
    );
    const heldMid = held ? midPrice(held.bid, held.ask) : null;
    const heldIv = held?.impliedVolatility ?? null;
    const heldDelta = held ? callDelta(price, existingLong.strike, leapsDte, heldIv) : null;
    base.leapsMid = heldMid;
    base.leapsIv = heldIv !== null ? Number((heldIv * 100).toFixed(1)) : null;
    base.leapsDelta = heldDelta !== null ? Number(heldDelta.toFixed(3)) : null;
    if (heldMid !== null) {
      const intrinsic = Math.max(price - existingLong.strike, 0);
      base.leapsExtrinsic = Number((heldMid - intrinsic).toFixed(2));
      base.leapsExtrinsicPerDelta =
        heldDelta !== null && heldDelta > 0 ? Number(((heldMid - intrinsic) / heldDelta).toFixed(2)) : null;
    }
    leapsDebitPerShare = params.longDebitPerShare ?? heldMid;
    base.widthBasis = params.longDebitPerShare !== null && params.longDebitPerShare !== undefined
      ? "caller-debit"
      : heldMid !== null ? "chain-mid" : "unknown";
    // Priced only when the chain quotes the held long or the caller passed a
    // debit. Otherwise the Width Rule cannot be verified, and no short can be
    // priced against it — report the long honestly instead of inventing a debit.
    const longPriced = heldMid !== null || params.longDebitPerShare !== null;
    if (!longPriced) {
      base.skipReason = "Existing long call held, but no chain quote and no longDebit passed — Width Rule unverifiable";
      return base;
    }
    // `leaps` stays null here by design: the existing-long path carries its
    // values on `base.*` and `leapsDebitPerShare`, not on a fresh LegQuote.
  } else {
    if (!leapsChain) {
      base.skipReason = `LEAPS chain unavailable (${leapsError ?? "unknown stack error"})`;
      base.sourceErrors = [leapsError].filter((e): e is string => e !== null);
      return base;
    }
    const candidates: LegQuote[] = [];
    for (const c of leapsChain.contractsList) {
      if (c.kind !== "call" || c.strike === null || c.strike >= price) continue; // ITM only
      const dte = daysToExpiry(c.expiry);
      if (dte === null || dte < params.leapsDteMin || dte > params.leapsDteMax) continue;
      const mid = midPrice(c.bid, c.ask);
      const spread = spreadPct(c.bid, c.ask);
      if (mid === null || mid <= 0 || c.bid === null || c.bid < MIN_BID) continue;
      if (spread === null || spread > params.maxSpreadPct) continue;
      const delta = callDelta(price, c.strike, dte, c.impliedVolatility);
      if (delta === null || delta < params.leapsDeltaMin || delta > params.leapsDeltaMax) continue;
      const intrinsic = Math.max(price - c.strike, 0);
      const extrinsic = mid - intrinsic;
      if (extrinsic < 0) continue; // crossed/stale quote, not a real price
      candidates.push({ contract: c, dte, mid, delta });
    }
    if (!candidates.length) {
      base.skipReason = `No LEAPS call with delta in ${params.leapsDeltaMin}-${params.leapsDeltaMax} in ${params.leapsDteMin}-${params.leapsDteMax} DTE under the spread filter`;
      return base;
    }
    // Cheapest surrogate shares: lowest extrinsic value per point of delta.
    candidates.sort((a, b) => {
      const ea = (a.mid - Math.max(price - (a.contract.strike as number), 0)) / a.delta;
      const eb = (b.mid - Math.max(price - (b.contract.strike as number), 0)) / b.delta;
      if (ea !== eb) return ea - eb;
      return b.delta - a.delta;
    });
    leaps = candidates[0];
    const lStrike = leaps.contract.strike as number;
    const intrinsic = Math.max(price - lStrike, 0);
    base.leapsStrike = lStrike;
    base.leapsExpiry = leaps.contract.expiry;
    base.leapsDte = leaps.dte;
    base.leapsMid = leaps.mid;
    base.leapsDelta = Number(leaps.delta.toFixed(3));
    base.leapsIv = leaps.contract.impliedVolatility !== null ? Number((leaps.contract.impliedVolatility * 100).toFixed(1)) : null;
    base.leapsExtrinsic = Number((leaps.mid - intrinsic).toFixed(2));
    base.leapsExtrinsicPerDelta = Number(((leaps.mid - intrinsic) / leaps.delta).toFixed(2));
    leapsDebitPerShare = leaps.mid;
    base.widthBasis = "leaps-mid";
  }

  const leapsStrike = base.leapsStrike as number;
  const leapsDebit = (leapsDebitPerShare ?? base.leapsMid ?? 0) * 100;
  base.leapsDebit = leapsDebit > 0 ? Number(leapsDebit.toFixed(2)) : null;
  const floor = leapsDebitPerShare !== null ? widthFloor(leapsStrike, leapsDebitPerShare) : null;
  base.widthFloor = floor;
  base.widthRule = floor === null ? "unknown" : "pass"; // fail is set below, per short

  // ---- Short leg ----------------------------------------------------------
  if (!shortChain) {
    base.skipReason = `Short-leg chain unavailable (${shortError ?? "unknown stack error"})`;
    base.sourceErrors = [shortError].filter((e): e is string => e !== null);
    return base;
  }
  const shortCandidates: LegQuote[] = [];
  for (const c of shortChain.contractsList) {
    if (c.kind !== "call" || c.strike === null) continue;
    const dte = daysToExpiry(c.expiry);
    if (dte === null || dte < params.shortDteMin || dte > params.shortDteMax) continue;
    const mid = midPrice(c.bid, c.ask);
    const spread = spreadPct(c.bid, c.ask);
    if (mid === null || mid <= 0 || c.bid === null || c.bid < MIN_BID) continue;
    if (spread === null || spread > params.maxSpreadPct) continue;
    const delta = callDelta(price, c.strike, dte, c.impliedVolatility);
    if (delta === null || Math.abs(delta) < params.shortDeltaMin || Math.abs(delta) > params.shortDeltaMax) continue;
    if (floor !== null && c.strike < floor) continue; // Width Rule, enforced at selection
    shortCandidates.push({ contract: c, dte, mid, delta });
  }
  if (!shortCandidates.length) {
    // An existing short call turns "no candidate" into a BLOCKED row, not a
    // skip: the doubling block is the answer regardless of whether a new
    // short clears the floor. Without this, a long + open short looks
    // identical to a long with no short at all (the run-B bug).
    if (existingShort) {
      const sDte = existingShort.expiry ? daysToExpiry(existingShort.expiry) : null;
      base.verdict = "BLOCKED";
      base.status = "avoid";
      base.blockReasons = [
        `Already short a ${ticker} call in this account` +
        (existingShort.strike && existingShort.expiry ? ` (${currency(existingShort.strike)} call, ${existingShort.expiry})` : "") +
        " — the long covers one short only, no doubling",
      ];
      base.managementFlags = [
        "LEAPS held while a short is open — never sell the long first.",
        `Existing short call${existingShort.strike ? ` ${currency(existingShort.strike)}` : ""}` +
        `${existingShort.expiry ? ` expiring ${existingShort.expiry}` : ""}` +
        `${sDte !== null ? ` (${sDte} DTE)` : ""} — no new short until it closes.`,
        ...(sDte !== null && sDte <= 21 ? ["21-DTE time stop: existing short inside 21 DTE — close per rule."] : []),
        "No new short screened: none clears the Width Rule floor while the existing short is open.",
      ];
      return base;
    }
    base.skipReason = floor !== null
      ? `No ${params.shortDteMin}-${params.shortDteMax} DTE call in delta ${params.shortDeltaMin}-${params.shortDeltaMax} at/above the Width Rule floor ${currency(floor)}`
      : `No ${params.shortDteMin}-${params.shortDteMax} DTE call in delta ${params.shortDeltaMin}-${params.shortDeltaMax} (Width Rule floor unknown)`;
    return base;
  }
  shortCandidates.sort((a, b) => b.mid - a.mid); // richest short premium first
  const short = shortCandidates[0];
  const sStrike = short.contract.strike as number;
  base.shortStrike = sStrike;
  base.shortExpiry = short.contract.expiry;
  base.shortDte = short.dte;
  base.shortMid = short.mid;
  base.shortCredit = Number((short.mid * 100).toFixed(2));
  base.shortDelta = Number(short.delta.toFixed(3));
  base.shortIv = short.contract.impliedVolatility !== null ? Number((short.contract.impliedVolatility * 100).toFixed(1)) : null;
  if (base.leapsDebit !== null && base.leapsDebit > 0) {
    base.premiumSharePct = Number(((base.shortCredit / base.leapsDebit) * 100).toFixed(2));
    base.annYieldPct = annualizedYield(base.shortCredit, base.leapsDebit, short.dte);
  }
  if (base.shortIv !== null && base.leapsIv !== null) {
    base.ivTermSpreadPp = Number((base.shortIv - base.leapsIv).toFixed(1));
  }
  // Call-put IV skew at the short strike/expiry: the matching put's IV, when listed.
  const matchingPut = shortChain.contractsList.find(
    (c) => c.kind === "put" && c.strike === sStrike && c.expiry === short.contract.expiry,
  );
  if (matchingPut && matchingPut.impliedVolatility !== null && short.contract.impliedVolatility !== null) {
    base.callPutSkewPp = Number(((short.contract.impliedVolatility - matchingPut.impliedVolatility) * 100).toFixed(1));
  }

  // ---- Gates ---------------------------------------------------------------
  const blockReasons: string[] = [];
  const managementFlags: string[] = [
    "LEAPS held while a short is open — never sell the long first.",
  ];

  if (existingShort) {
    const sDte = existingShort.expiry ? daysToExpiry(existingShort.expiry) : null;
    blockReasons.push(
      `Already short a ${ticker} call in this account` +
      (existingShort.strike && existingShort.expiry ? ` (${currency(existingShort.strike)} call, ${existingShort.expiry})` : "") +
      " — the long covers one short only, no doubling",
    );
    managementFlags.push(
      `Existing short call${existingShort.strike ? ` ${currency(existingShort.strike)}` : ""}` +
      `${existingShort.expiry ? ` expiring ${existingShort.expiry}` : ""}` +
      `${sDte !== null ? ` (${sDte} DTE)` : ""} — no new short until it closes.`,
    );
    if (sDte !== null && sDte <= 21) {
      managementFlags.push("21-DTE time stop: existing short inside 21 DTE — close per rule.");
    }
  }

  if (daysToEarnings !== null && daysToEarnings >= 0 && daysToEarnings <= short.dte) {
    blockReasons.push(`Earnings in ${daysToEarnings}DTE — inside the short leg's life, never across earnings`);
  }

  const rule6 = checkRule6Gate("call", marketDirection);
  if (!rule6.passed) blockReasons.push(rule6.reason ?? rule6.gateName);

  // Coverage: long strike <= short strike and long expiry after short expiry.
  const leapsExpiry = base.leapsExpiry as string;
  if (!(leapsStrike <= sStrike && leapsExpiry > short.contract.expiry)) {
    blockReasons.push("Short not covered by the long (long strike/expiry do not cover the short)");
  }
  if (floor !== null && sStrike < floor) {
    base.widthRule = "fail";
    blockReasons.push(`Short strike ${currency(sStrike)} below Width Rule floor ${currency(floor)} (LEAPS strike + net debit)`);
  }

  // Concentration: the LEAPS value counts toward the ticker's 30% cap.
  const newCapital = base.mode === "fresh" ? (base.leapsDebit ?? 0) : (base.leapsMid !== null ? base.leapsMid * 100 : 0);
  const concentrationReason = concentrationBlock(ticker, params.accountValue, existingTickerValue ?? 0, newCapital);
  if (concentrationReason) blockReasons.push(concentrationReason);

  // No margin: a fresh LEAPS debit must fit inside reported free cash.
  if (base.mode === "fresh" && ctx && ctx.freeCash !== null && ctx.freeCash !== undefined && base.leapsDebit !== null) {
    if (base.leapsDebit > ctx.freeCash) {
      blockReasons.push(`LEAPS debit ${currency(base.leapsDebit)} exceeds free cash ${currency(ctx.freeCash)} — cash-paid only, no margin`);
    }
  }

  base.blockReasons = blockReasons;
  base.managementFlags = managementFlags;
  base.verdict = blockReasons.length ? "BLOCKED" : "APPROVED";
  if (base.verdict === "BLOCKED") {
    base.status = "avoid";
  } else if (base.widthRule === "unknown") {
    base.status = "watch";
    base.managementFlags.push("Width Rule unchecked: no caller debit and no chain quote for the long — pass longDebit to verify.");
  } else if (base.premiumSharePct === null || base.premiumSharePct < params.minPremiumSharePct) {
    base.status = "watch";
  } else {
    base.status = "ready";
  }
  return base;
}

export async function runPmccScreener(params: PmccParams) {
  // SEQUENTIAL ticker loop — the second half of the burst fix. The old
  // Promise.all fired every ticker's four Yahoo calls at once; on shared
  // egress that reads as a burst and gets throttled. Sequential is slower
  // per scan, so keep universes modest (~10 tickers per call stays inside
  // the route's 60s limit, as the route already documents). The chain
  // cache makes repeat screens cheap.
  const rows: PmccCandidateRow[] = [];
  for (const ticker of params.tickers) {
    try {
      rows.push(await screenOneTicker(ticker, params));
    } catch (error) {
      rows.push({
        ticker, status: "avoid", verdict: null, price: null, dayChangePct: null,
        mode: "fresh", leapsStrike: null, leapsExpiry: null, leapsDte: null,
        leapsMid: null, leapsDebit: null, leapsDelta: null, leapsIv: null,
        leapsExtrinsic: null, leapsExtrinsicPerDelta: null, shortStrike: null,
        shortExpiry: null, shortDte: null, shortMid: null, shortCredit: null,
        shortDelta: null, shortIv: null, premiumSharePct: null, annYieldPct: null,
        ivTermSpreadPp: null, callPutSkewPp: null, widthFloor: null,
        widthRule: "unknown", widthBasis: "unknown", daysToEarnings: null,
        blockReasons: [], skipReason: error instanceof Error ? error.message : "Unexpected PMCC screener error",
        managementFlags: [], outlierFlags: [], isOutlier: false, existingTickerValue: null,
        chainSource: null, sourceErrors: [],
      });
    }
  }

  // Outlier population = rows with a complete structure only. Skipped rows
  // (no structure) carry no metrics and must not dilute the population.
  const structured = rows.filter((r) => r.skipReason === null);
  const flagSets = computeOutlierFlags(structured, PMCC_METRICS, params.zThreshold);
  structured.forEach((row, i) => {
    row.outlierFlags = flagSets[i];
    row.isOutlier = flagSets[i].length > 0;
  });

  const statusOrder = { ready: 0, watch: 1, avoid: 2 } as const;
  rows.sort((a, b) => {
    // Outlier "ready" rows first — extremes worth a look — then ready, watch, avoid.
    const aRank = statusOrder[a.status] - (a.status === "ready" && a.isOutlier ? 0.5 : 0);
    const bRank = statusOrder[b.status] - (b.status === "ready" && b.isOutlier ? 0.5 : 0);
    if (aRank !== bRank) return aRank - bRank;
    return (b.annYieldPct ?? -Infinity) - (a.annYieldPct ?? -Infinity);
  });

  const ctx = params.accountContext ?? null;
  return {
    scannedAt: new Date().toISOString(),
    accountContext: ctx
      ? {
          account: ctx.account ?? null,
          accountValue: params.accountValue,
          freeCash: ctx.freeCash ?? null,
          reservedCollateral: ctx.reservedCollateral ?? null,
          positionCount: ctx.positions.length,
        }
      : null,
    dataNote:
      "Yahoo IV and delta are model outputs, not exchange quotes, and chains can be stale. " +
      "Chains come from the market-data stack: Yahoo first, then CBOE delayed quotes " +
      "(~15 min delayed) and Tradier sandbox (~15 min delayed) as fallbacks — every row " +
      "names its chainSource. Rows are candidates for Ryan's review only — never a fill " +
      "verification, never a trade.",
    results: rows,
    metrics: metricPopulations(structured, PMCC_METRICS),
    summary: {
      scanned: rows.length,
      ready: rows.filter((r) => r.status === "ready").length,
      watch: rows.filter((r) => r.status === "watch").length,
      avoid: rows.filter((r) => r.status === "avoid").length,
      errors: rows.filter((r) => r.skipReason !== null).length,
      outliers: rows.filter((r) => r.isOutlier).length,
    },
  };
}
