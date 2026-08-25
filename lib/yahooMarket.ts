// Market data via yahoo-finance2 (github.com/gadicc/yahoo-finance2) — options chain,
// underlying price, and daily bars, all from one free, key-less, actively maintained
// package. Replaces the earlier Alpaca integration: Alpaca required credentials Ryan
// didn't have on hand, and this package already covers the same ground (plus earnings,
// see lib/earnings.ts) without any signup.

import YahooFinance from "yahoo-finance2";
import { calculateMaxPain, type ChainContract } from "./maxPain";

// validation.logErrors/logOptionsErrors only silences yahoo-finance2's own console spam
// when a symbol's response doesn't match its internal schema (happens occasionally on
// thinly-optioned or oddly-shaped chains) — it still throws, so that ticker still lands
// in the screener's per-ticker skipReason exactly as before. This just keeps a 194-ticker
// scan's terminal output readable instead of dumping a schema dump per flaky symbol.
const yahooFinance = new YahooFinance({
  suppressNotices: ["yahooSurvey"],
  validation: { logErrors: false, logOptionsErrors: false },
});

const REQUEST_TIMEOUT_MS = 12_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

export type NormalizedContract = ChainContract & {
  ticker: string;
  expiry: string;
  bid: number | null;
  ask: number | null;
  last: number | null;
  volume: number | null;
  impliedVolatility: number | null;
};

export type OptionsSummary = {
  ticker: string;
  contractsList: NormalizedContract[];
  maxPain: number | null;
  underlyingPrice: number | null;
};

function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toDateString(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "string" || typeof v === "number") {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return "";
}

export async function fetchOptionsSummary(ticker: string, expirationGte?: string, expirationLte?: string): Promise<OptionsSummary> {
  const symbol = ticker.trim().toUpperCase();

  // Yahoo returns ONE expiration per call. Fetch the list of expiration dates first,
  // then only pull the ones inside our DTE window (bounded, so a long-dated chain can't
  // spin this into dozens of requests).
  const first = await withTimeout(yahooFinance.options(symbol), REQUEST_TIMEOUT_MS, `yahoo options(${symbol})`);
  const underlyingPrice = toNum(first.quote?.regularMarketPrice) ?? null;

  const allExpirations = (first.expirationDates ?? []).map((d) => toDateString(d)).filter(Boolean);
  const inWindow = allExpirations.filter((exp) => (!expirationGte || exp >= expirationGte) && (!expirationLte || exp <= expirationLte));
  // Always keep whatever the first call already fetched (usually the nearest expiration),
  // plus up to 5 more inside the window, so one ticker can't blow the request budget.
  const targets = new Set(inWindow.slice(0, 6));

  const extraTargets = Array.from(targets).filter((exp) => exp !== toDateString(first.options?.[0]?.expirationDate));
  const extraChains: (typeof first)[] = [];
  for (const exp of extraTargets) {
    try {
      const chain = await withTimeout(
        yahooFinance.options(symbol, { date: new Date(`${exp}T00:00:00Z`) }),
        REQUEST_TIMEOUT_MS,
        `yahoo options(${symbol}, ${exp})`,
      );
      extraChains.push(chain);
    } catch {
      // One bad expiration date shouldn't drop the rest of the chain.
    }
  }
  const chains = [first, ...extraChains];

  const rows: NormalizedContract[] = [];
  for (const chain of chains) {
    for (const group of chain.options ?? []) {
      const expiry = toDateString(group.expirationDate);
      if (expirationGte && expiry < expirationGte) continue;
      if (expirationLte && expiry > expirationLte) continue;
      for (const put of group.puts ?? []) {
        rows.push({
          ticker: put.contractSymbol,
          kind: "put",
          strike: toNum(put.strike),
          expiry,
          bid: toNum(put.bid),
          ask: toNum(put.ask),
          last: toNum(put.lastPrice),
          volume: toNum(put.volume),
          openInterest: toNum(put.openInterest),
          impliedVolatility: toNum(put.impliedVolatility),
        });
      }
      for (const call of group.calls ?? []) {
        rows.push({
          ticker: call.contractSymbol,
          kind: "call",
          strike: toNum(call.strike),
          expiry,
          bid: toNum(call.bid),
          ask: toNum(call.ask),
          last: toNum(call.lastPrice),
          volume: toNum(call.volume),
          openInterest: toNum(call.openInterest),
          impliedVolatility: toNum(call.impliedVolatility),
        });
      }
    }
  }

  if (!rows.length) {
    throw new Error(`No option chain returned by Yahoo for ${symbol} in the ${expirationGte ?? "?"}..${expirationLte ?? "?"} window`);
  }

  return {
    ticker: symbol,
    contractsList: rows,
    maxPain: calculateMaxPain(rows),
    underlyingPrice,
  };
}

export type DailyBar = { date: string; close: number; high: number; low: number; volume: number };

export async function fetchDailyBars(ticker: string, lookbackDays = 120): Promise<DailyBar[]> {
  const symbol = ticker.trim().toUpperCase();
  const period2 = new Date();
  const period1 = new Date(period2.getTime() - lookbackDays * 86_400_000);

  const result = await withTimeout(
    yahooFinance.chart(symbol, { period1, period2, interval: "1d" }),
    REQUEST_TIMEOUT_MS,
    `yahoo chart(${symbol})`,
  );

  const quotes = result.quotes ?? [];
  const bars = quotes
    .filter((q) => q.close !== null && q.close !== undefined)
    .map((q) => ({
      date: toDateString(q.date),
      close: q.close as number,
      high: (q.high as number) ?? (q.close as number),
      low: (q.low as number) ?? (q.close as number),
      volume: (q.volume as number) ?? 0,
    }));

  if (!bars.length) {
    throw new Error(`No daily bars returned by Yahoo for ${symbol}`);
  }
  return bars;
}
