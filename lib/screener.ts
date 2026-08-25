// CSP screener orchestrator.
//
// Design principle (learned from the old app's failure): one ticker's data problem must
// never blank out the whole screener, and a skip reason must always be the REAL reason —
// never a generic catch-all that lies about why a ticker was dropped (see the
// CODEX-BRIEF-csp-screener.md postmortem on the old desktop app for exactly this bug).

import { runPreTradeChecklist, verdictFor, currency, type MarketDirection } from "./gates";
import { fetchOptionsSummary, fetchDailyBars, type NormalizedContract } from "./yahooMarket";
import { analyzeTechnicals, type DivergenceSignal } from "./technicals";
import { fetchNextEarningsDate } from "./earnings";

export type ScreenerParams = {
  tickers: string[];
  dteMin: number;
  dteMax: number;
  minRoiPct: number;
  excludeEarningsWithinDays: number;
  accountValue: number;
};

export type CandidateStatus = "ready" | "watch" | "avoid";

export type CspCandidateRow = {
  ticker: string;
  status: CandidateStatus;
  verdict: "APPROVED" | "BLOCKED" | null;
  score: number | null;
  price: number | null;
  strike: number | null;
  expiry: string | null;
  dte: number | null;
  bid: number | null;
  credit: number | null;
  roiPct: number | null;
  annRoiPct: number | null;
  maxPain: number | null;
  rsi: number | null;
  divergence: DivergenceSignal;
  divergenceNote: string | null;
  daysToEarnings: number | null;
  blockReasons: string[];
  skipReason: string | null;
};

function daysToExpiry(expiry: string): number | null {
  const d = new Date(`${expiry}T20:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  return Math.max(0, Math.round((d.getTime() - Date.now()) / 86_400_000));
}

function mid(contract: NormalizedContract): number | null {
  if (contract.bid !== null && contract.ask !== null && contract.bid > 0 && contract.ask >= contract.bid) {
    return Number(((contract.bid + contract.ask) / 2).toFixed(2));
  }
  return contract.bid && contract.bid > 0 ? contract.bid : null;
}

// Minimum bid before a contract is even considered a candidate. Anything below this is
// an unfillable "junk" quote (a real bug this exact constant was added to fix: on live
// data, a deep-OTM $309 AAPL's $120 put with a $0.01 bid was outscoring every real
// candidate because the uncapped max-pain-distance bonus below swamped its near-zero ROI).
export const MIN_BID = 0.05;

export function scoreCandidate(roiPct: number, dte: number, maxPain: number | null, strike: number, rsi: number | null, divergence: DivergenceSignal) {
  const rawPainDistance = maxPain && maxPain > 0 ? Math.max(0, ((maxPain - strike) / maxPain) * 100) : 0;
  // Max-pain distance is a safety tilt, not the primary driver — ROI is what the trader
  // actually collects. Cap it so it can never outweigh a real premium difference.
  const painDistanceBonus = Math.min(rawPainDistance, 15);
  const dteFit = dte >= 21 && dte <= 45 ? 18 : dte >= 14 && dte <= 60 ? 8 : -20;
  const rsiBonus = rsi !== null && rsi < 35 ? 10 : 0;
  const divergenceBonus = divergence === "bullish" ? 8 : divergence === "bearish" ? -4 : 0;
  return Number((roiPct * 18 + painDistanceBonus + dteFit + rsiBonus + divergenceBonus).toFixed(2));
}

async function screenOneTicker(ticker: string, params: ScreenerParams): Promise<CspCandidateRow> {
  const base: CspCandidateRow = {
    ticker,
    status: "avoid",
    verdict: null,
    score: null,
    price: null,
    strike: null,
    expiry: null,
    dte: null,
    bid: null,
    credit: null,
    roiPct: null,
    annRoiPct: null,
    maxPain: null,
    rsi: null,
    divergence: "none",
    divergenceNote: null,
    daysToEarnings: null,
    blockReasons: [],
    skipReason: null,
  };

  const expiryFrom = new Date(Date.now() + params.dteMin * 86_400_000).toISOString().slice(0, 10);
  const expiryTo = new Date(Date.now() + params.dteMax * 86_400_000).toISOString().slice(0, 10);

  const [chainResult, barsResult, earningsResult] = await Promise.allSettled([
    fetchOptionsSummary(ticker, expiryFrom, expiryTo),
    fetchDailyBars(ticker, 120),
    fetchNextEarningsDate(ticker),
  ]);

  if (chainResult.status === "rejected") {
    base.skipReason = chainResult.reason instanceof Error ? chainResult.reason.message : "Failed to load option chain";
    return base;
  }
  const chain = chainResult.value;
  base.price = chain.underlyingPrice;
  base.maxPain = chain.maxPain;

  if (chain.underlyingPrice === null) {
    base.skipReason = "No live underlying price returned";
    return base;
  }

  let marketDirection: MarketDirection = "red";
  let technicals = { rsi: null as number | null, divergence: "none" as DivergenceSignal, divergenceNote: null as string | null };
  if (barsResult.status === "fulfilled" && barsResult.value.length >= 2) {
    const bars = barsResult.value;
    const last = bars[bars.length - 1];
    const prev = bars[bars.length - 2];
    marketDirection = last.close >= prev.close ? "green" : "red";
    technicals = analyzeTechnicals(bars);
  } else {
    base.skipReason = barsResult.status === "rejected" ? `Technicals unavailable: ${(barsResult.reason as Error)?.message ?? "no bars"}` : null;
  }
  base.rsi = technicals.rsi;
  base.divergence = technicals.divergence;
  base.divergenceNote = technicals.divergenceNote;

  const daysToEarnings = earningsResult.status === "fulfilled" ? earningsResult.value?.daysToEarnings ?? null : null;
  base.daysToEarnings = daysToEarnings;

  // Candidate puts: OTM (strike below spot), inside the DTE window, quotable.
  const puts = chain.contractsList.filter((c) => c.kind === "put" && c.strike !== null && c.strike < (chain.underlyingPrice as number));
  const withDte = puts
    .map((c) => ({ contract: c, dte: daysToExpiry(c.expiry) }))
    .filter((c): c is { contract: NormalizedContract; dte: number } => c.dte !== null && c.dte >= params.dteMin && c.dte <= params.dteMax);

  if (!withDte.length) {
    base.skipReason = `No put contracts between ${params.dteMin}-${params.dteMax} DTE with strike below spot ${currency(chain.underlyingPrice)}`;
    return base;
  }

  let best: { contract: NormalizedContract; dte: number; m: number; roiPct: number; score: number } | null = null;
  let sawQuotedContract = false;
  for (const { contract, dte } of withDte) {
    if (contract.bid !== null && contract.bid > 0) sawQuotedContract = true;
    // A bid below MIN_BID is a junk/unfillable quote, not a real candidate.
    if (contract.bid === null || contract.bid < MIN_BID || contract.strike === null) continue;
    const m = mid(contract);
    if (m === null || m <= 0) continue;
    const capital = contract.strike * 100;
    const credit = m * 100;
    const roiPct = (credit / capital) * 100;
    const score = scoreCandidate(roiPct, dte, chain.maxPain, contract.strike, technicals.rsi, technicals.divergence);
    if (!best || score > best.score) best = { contract, dte, m, roiPct, score };
  }

  if (!best) {
    base.skipReason = sawQuotedContract
      ? `Chain has quotes in range, but every bid is below the $${MIN_BID.toFixed(2)} junk-quote floor`
      : "No two-sided (bid/ask) quotes in range - chain listed but unquoted";
    return base;
  }

  const strike = best.contract.strike as number;
  const credit = Number((best.m * 100).toFixed(2));
  const capital = strike * 100;
  const annRoiPct = best.dte > 0 ? (best.roiPct * 365) / best.dte : null;

  const gates = chain.maxPain
    ? runPreTradeChecklist({
        ticker,
        kind: "put",
        strike,
        maxPain: chain.maxPain,
        marketDirection,
        daysToEarnings,
        newCapital: capital,
        accountValue: params.accountValue,
        currentTickerValue: 0,
      })
    : [{ passed: false, gateName: "Max Pain", reason: "Max pain unavailable (insufficient open interest data)" }];

  const verdict = verdictFor(gates) as "APPROVED" | "BLOCKED";
  const blockReasons = gates.filter((g) => !g.passed).map((g) => g.reason ?? g.gateName);

  const earningsBlocked = daysToEarnings !== null && daysToEarnings >= 0 && daysToEarnings <= params.excludeEarningsWithinDays;
  if (earningsBlocked && !blockReasons.some((r) => r.toLowerCase().includes("earnings"))) {
    blockReasons.push(`Earnings in ${daysToEarnings}d - inside ${params.excludeEarningsWithinDays}d exclusion window`);
  }

  const meetsRoi = best.roiPct >= params.minRoiPct;
  const status: CandidateStatus = verdict === "APPROVED" && !earningsBlocked && meetsRoi ? "ready" : verdict === "APPROVED" && !earningsBlocked ? "watch" : "avoid";

  return {
    ...base,
    status,
    verdict,
    score: best.score,
    strike,
    expiry: best.contract.expiry,
    dte: best.dte,
    bid: best.contract.bid,
    credit,
    roiPct: Number(best.roiPct.toFixed(2)),
    annRoiPct: annRoiPct !== null ? Number(annRoiPct.toFixed(1)) : null,
    blockReasons: earningsBlocked ? [...blockReasons] : blockReasons,
    skipReason: null,
  };
}

export async function runScreener(params: ScreenerParams) {
  const results = await Promise.all(params.tickers.map((ticker) => screenOneTicker(ticker, params).catch((error) => ({
    ...({} as CspCandidateRow),
    ticker,
    status: "avoid" as CandidateStatus,
    verdict: null,
    score: null,
    price: null,
    strike: null,
    expiry: null,
    dte: null,
    bid: null,
    credit: null,
    roiPct: null,
    annRoiPct: null,
    maxPain: null,
    rsi: null,
    divergence: "none" as DivergenceSignal,
    divergenceNote: null,
    daysToEarnings: null,
    blockReasons: [],
    skipReason: error instanceof Error ? error.message : "Unexpected screener error",
  }))));

  results.sort((a, b) => {
    const order = { ready: 0, watch: 1, avoid: 2 } as const;
    if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
    return (b.score ?? -Infinity) - (a.score ?? -Infinity);
  });

  return {
    scannedAt: new Date().toISOString(),
    results,
    summary: {
      scanned: results.length,
      ready: results.filter((r) => r.status === "ready").length,
      watch: results.filter((r) => r.status === "watch").length,
      avoid: results.filter((r) => r.status === "avoid").length,
      errors: results.filter((r) => r.skipReason !== null).length,
    },
  };
}
