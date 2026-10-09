// Earnings-date lookup via yahoo-finance2 (github.com/gadicc/yahoo-finance2) — a maintained,
// pure JS/TS reimplementation of the Yahoo endpoints the old yfinance/Python path used.
// No subprocess, no Python — this is the fix for the "spawn python3 ENOENT" failure.
//
// This call is intentionally non-fatal: earnings data failing to load should never take
// down a whole ticker's screener result the way the old single-endpoint design did.

import YahooFinance from "yahoo-finance2";

const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

export type EarningsInfo = {
  nextEarningsDate: string | null;
  daysToEarnings: number | null;
  source: "yahoo-finance2";
} | null;

const EARNINGS_TIMEOUT_MS = 8_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

export async function fetchNextEarningsDate(ticker: string): Promise<EarningsInfo> {
  try {
    const result = await withTimeout(
      yahooFinance.quoteSummary(ticker, { modules: ["calendarEvents"] }),
      EARNINGS_TIMEOUT_MS,
      "yahoo-finance2 earnings lookup",
    );
    const raw = result.calendarEvents?.earnings?.earningsDate;
    const dates = Array.isArray(raw) ? raw : raw ? [raw] : [];
    if (!dates.length) return null;

    const next = dates
      .map((d) => (d instanceof Date ? d : new Date(d as unknown as string)))
      .filter((d) => !Number.isNaN(d.getTime()))
      .sort((a, b) => a.getTime() - b.getTime())[0];
    if (!next) return null;

    const daysToEarnings = Math.round((next.getTime() - Date.now()) / 86_400_000);
    return {
      nextEarningsDate: next.toISOString().slice(0, 10),
      daysToEarnings,
      source: "yahoo-finance2",
    };
  } catch {
    // Non-fatal: caller treats null as "unknown, don't block on it."
    return null;
  }
}
