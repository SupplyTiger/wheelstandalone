// LAYER 2 — CBOE delayed-quotes fallback (market-data stack, Oct 2026).
//
// WHAT THIS IS: when Yahoo returns a skip for a ticker, the stack falls back
// to CBOE's own delayed-quotes JSON feed — the same data behind
// cboe.com's options pages, 15 minutes delayed, no signup, no key. Verified
// live Oct 2026: one request returns the FULL chain (all expiries, e.g.
// 7,322 META contracts from Oct 2026 through Jan 2029), each contract
// carrying bid, ask, IV, delta, gamma, vega, theta, rho, open interest,
// volume, and last trade price, plus an underlying block with current
// price and day change. That covers everything the screener needs —
// including IV, which the app's Black-Scholes delta path consumes — so
// the mapping below is complete, not partial.
//
// HOW IT'S USED: only as a fallback, only when Yahoo skips. The PMCC
// screener still computes delta from IV (lib/blackScholes.ts) for
// consistency with Yahoo-sourced rows; CBOE's own delta is carried in the
// raw payload but deliberately not used, so one code path scores every row
// regardless of source. Rows sourced from here are tagged "cboe" so a
// reader always knows the quote is ~15 minutes delayed.
//
// HONEST LIMITS, stated not hidden:
//   - This is CBOE's website feed, not a documented API: the URL shape can
//     change without notice. If it 404s or reshapes, the stack treats it
//     exactly like any other source failure and moves on (or reports all
//     sources failed) — it never half-maps a broken payload.
//   - Deep-ITM far-expiry IVs can be absurd (e.g. 484% on a $5 strike) —
//     the same meaningless-IV class the LEAPS 0.90 delta cap already
//     handles. Last-trade prices can be days stale; the screener prices
//     off bid/ask mids, never off last.
//   - All data here is screening-grade delayed data, never an execution
//     quote. The response's dataNote says so.

import { calculateMaxPain, type ChainContract } from "./maxPain";
import type { NormalizedContract, OptionsSummary } from "./yahooMarket";

const CBOE_TIMEOUT_MS = 20_000; // 3MB+ full-chain payloads need more than Yahoo's 12s
const CBOE_BASE = "https://cdn.cboe.com/api/global/delayed_quotes/options";

export type CboeRawOption = {
  option: string;
  bid: number | null;
  ask: number | null;
  last_trade_price: number | null;
  volume: number | null;
  open_interest: number | null;
  iv: number | null;
  delta?: number | null;
};

export type CboeRawPayload = {
  timestamp?: string;
  data: {
    symbol?: string;
    current_price?: number | null;
    price_change?: number | null;
    price_change_percent?: number | null;
    options: CboeRawOption[];
  };
};

function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * OCC option symbol: root letters + YYMMDD + C/P + 8-digit strike/1000.
 * e.g. META261026C00510000 -> META, 2026-10-26, call, $510. Returns null
 * for anything that doesn't parse — unparseable contracts are skipped,
 * never guessed at.
 */
export function parseCboeSymbol(sym: string): {
  expiry: string;
  kind: "call" | "put";
  strike: number;
} | null {
  const m = /^([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(sym.trim().toUpperCase());
  if (!m) return null;
  const [, , yy, mm, dd, type, strikeRaw] = m;
  const expiry = `20${yy}-${mm}-${dd}`;
  const d = new Date(`${expiry}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return { expiry, kind: type === "C" ? "call" : "put", strike: Number(strikeRaw) / 1000 };
}

/**
 * Pure mapper: CBOE delayed payload -> the screener's OptionsSummary
 * shape, filtered to the requested expiry window. Unit-tested with a
 * fixture; no network here, so the mapping is provable without a token
 * or a live call.
 */
export function mapCboePayload(
  payload: CboeRawPayload,
  symbol: string,
  expirationGte?: string,
  expirationLte?: string,
): OptionsSummary {
  const data = payload?.data;
  if (!data || !Array.isArray(data.options)) {
    throw new Error(`CBOE delayed feed returned no options array for ${symbol}`);
  }
  const rows: NormalizedContract[] = [];
  for (const o of data.options) {
    if (!o || typeof o.option !== "string") continue;
    const parsed = parseCboeSymbol(o.option);
    if (!parsed) continue;
    if (expirationGte && parsed.expiry < expirationGte) continue;
    if (expirationLte && parsed.expiry > expirationLte) continue;
    rows.push({
      ticker: o.option,
      kind: parsed.kind,
      strike: parsed.strike,
      expiry: parsed.expiry,
      bid: toNum(o.bid),
      ask: toNum(o.ask),
      last: toNum(o.last_trade_price),
      volume: toNum(o.volume),
      openInterest: toNum(o.open_interest),
      impliedVolatility: toNum(o.iv),
    });
  }
  if (!rows.length) {
    throw new Error(
      `No CBOE delayed chain for ${symbol} in the ${expirationGte ?? "?"}..${expirationLte ?? "?"} window`,
    );
  }
  const contracts: ChainContract[] = rows.map((r) => ({
    kind: r.kind,
    strike: r.strike,
    openInterest: r.openInterest,
  }));
  return {
    ticker: symbol,
    contractsList: rows,
    maxPain: calculateMaxPain(contracts),
    underlyingPrice: toNum(data.current_price),
    dayChange: toNum(data.price_change),
    dayChangePct: toNum(data.price_change_percent),
  };
}

async function fetchWithTimeout(url: string, ms: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "wheelstandalone-screener" },
    });
    if (!res.ok) {
      throw new Error(`CBOE delayed feed HTTP ${res.status} for ${url}`);
    }
    return (await res.json()) as unknown;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`CBOE delayed feed timed out after ${ms}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Live CBOE delayed fetch for one ticker, filtered to the window.
 * Throws on any failure — the stack treats a CBOE failure as "try the
 * next source", never as a partial chain.
 */
export async function fetchCboeChain(
  ticker: string,
  expirationGte?: string,
  expirationLte?: string,
): Promise<OptionsSummary> {
  const symbol = ticker.trim().toUpperCase();
  const payload = (await fetchWithTimeout(
    `${CBOE_BASE}/${encodeURIComponent(symbol)}.json`,
    CBOE_TIMEOUT_MS,
  )) as CboeRawPayload;
  return mapCboePayload(payload, symbol, expirationGte, expirationLte);
}
