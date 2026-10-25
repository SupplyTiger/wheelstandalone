// LAYER 3 — Tradier sandbox adapter (market-data stack, Oct 2026).
//
// WHAT THIS IS: a code-ready adapter for Tradier's free developer sandbox
// (no brokerage account required, REST, 15-minute delayed chains with
// basic Greeks). It is DORMANT without a token: the token comes only from
// the TRADIER_SANDBOX_TOKEN env var, is never logged, never committed,
// and never faked. With no token, the stack skips this leg and says so —
// it never pretends Tradier answered.
//
// WHAT RYAN MUST DO (the ONLY step this whole stack needs from him):
//   1. Sign up free at tradier.com and open API Access -> Sandbox Account
//      Access, then generate a sandbox access token.
//   2. Set it as a Vercel env var named TRADIER_SANDBOX_TOKEN (production
//      scope) on the wheelstandalone project, then redeploy.
// No brokerage account, no funding, no live trading is involved — the
// sandbox serves delayed data only, which is exactly what a screener
// needs. Until that token exists, this file is tested with mocked
// responses only; live Tradier verification waits on the token.
//
// MAPPING HONESTY: the Tradier chain shape below follows Tradier's public
// REST docs (options.chains with greeks=true, options.expirations,
// markets.quotes). IV is read defensively as mid_iv, else bid_iv, else
// ask_iv, else iv — if Tradier's live greeks shape differs, the first
// live-token run will show it immediately (IVs come back null and the
// screener's delta path reports it), and the mapping gets corrected
// then. Nothing here invents an IV: null stays null, and a null-IV leg
// is filtered by the screener's own delta rules, not scored.
//
// All data here is screening-grade delayed data (~15 min), never an
// execution quote.

import { calculateMaxPain, type ChainContract } from "./maxPain";
import type { NormalizedContract, OptionsSummary } from "./yahooMarket";

export const TRADIER_SANDBOX_BASE = "https://sandbox.tradier.com/v1";
const TRADIER_TIMEOUT_MS = 12_000;

/** Token source: env only. Returns null when unset — the leg stays dormant. */
export function getTradierToken(): string | null {
  const token = process.env.TRADIER_SANDBOX_TOKEN;
  return token && token.trim() !== "" ? token : null;
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function asArray<T>(v: T | T[] | null | undefined): T[] {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

async function tradierGet(
  token: string,
  path: string,
  params: Record<string, string>,
): Promise<unknown> {
  const url = new URL(`${TRADIER_SANDBOX_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRADIER_TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), {
      signal: controller.signal,
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(`Tradier sandbox HTTP ${res.status} for ${path}`);
    }
    return (await res.json()) as unknown;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Tradier sandbox timed out after ${TRADIER_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Pure: expiration dates out of an options.expirations response. */
export function mapTradierExpirations(json: unknown): string[] {
  const root = (json as { expirations?: { expiration?: unknown } } | null)?.expirations;
  const list = asArray(
    (root?.expiration as Array<{ date?: unknown }> | { date?: unknown } | undefined) ?? [],
  );
  return list
    .map((e) => (typeof e?.date === "string" ? e.date.slice(0, 10) : ""))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
}

/** Pure: one chains response -> normalized contracts (window-filtered). */
export function mapTradierChain(
  json: unknown,
  symbol: string,
  expirationGte?: string,
  expirationLte?: string,
): NormalizedContract[] {
  const root = (json as { options?: { option?: unknown } } | null)?.options;
  const list = asArray(root?.option as Array<Record<string, unknown>> | Record<string, unknown> | undefined);
  const rows: NormalizedContract[] = [];
  for (const o of list) {
    if (!o || typeof o !== "object") continue;
    const type = o.type === "call" ? "call" : o.type === "put" ? "put" : null;
    const expiry = typeof o.expiration_date === "string" ? o.expiration_date.slice(0, 10) : "";
    if (!type || !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) continue;
    if (expirationGte && expiry < expirationGte) continue;
    if (expirationLte && expiry > expirationLte) continue;
    const greeks = (o.greeks ?? {}) as Record<string, unknown>;
    const iv =
      toNum(greeks.mid_iv) ?? toNum(greeks.bid_iv) ?? toNum(greeks.ask_iv) ?? toNum(greeks.iv);
    rows.push({
      ticker: typeof o.symbol === "string" ? o.symbol : symbol,
      kind: type,
      strike: toNum(o.strike),
      expiry,
      bid: toNum(o.bid),
      ask: toNum(o.ask),
      last: toNum(o.last),
      volume: toNum(o.volume),
      openInterest: toNum(o.open_interest),
      impliedVolatility: iv,
    });
  }
  return rows;
}

/** Pure: underlying last price out of a markets.quotes response. */
export function mapTradierQuote(json: unknown): { price: number | null; changePct: number | null } {
  const root = (json as { quotes?: { quote?: unknown } } | null)?.quotes;
  const list = asArray(root?.quote as Array<Record<string, unknown>> | Record<string, unknown> | undefined);
  const q = list[0];
  if (!q) return { price: null, changePct: null };
  return { price: toNum(q.last) ?? toNum(q.close), changePct: toNum(q.change_percentage) };
}

/**
 * Live Tradier sandbox chain fetch for one ticker, filtered to the
 * window. Throws when the token is absent (dormant leg) or on any
 * request failure — the stack treats failure as "try the next source"
 * only in the sense that Tradier is last; a Tradier failure ends the
 * stack with all three sources' errors reported.
 */
export async function fetchTradierChain(
  ticker: string,
  expirationGte?: string,
  expirationLte?: string,
): Promise<OptionsSummary> {
  const symbol = ticker.trim().toUpperCase();
  const token = getTradierToken();
  if (!token) {
    throw new Error(
      "Tradier sandbox dormant: TRADIER_SANDBOX_TOKEN is not set — no token, no call, no fake data",
    );
  }

  const expJson = await tradierGet(token, "/markets/options/expirations", { symbol });
  const inWindow = mapTradierExpirations(expJson).filter(
    (d) => (!expirationGte || d >= expirationGte) && (!expirationLte || d <= expirationLte),
  );
  // Mirror Yahoo's bound: one ticker can't spin into dozens of requests.
  const targets = inWindow.slice(0, 6);
  const rows: NormalizedContract[] = [];
  for (const exp of targets) {
    const chainJson = await tradierGet(token, "/markets/options/chains", {
      symbol,
      expiration: exp,
      greeks: "true",
    });
    rows.push(...mapTradierChain(chainJson, symbol, expirationGte, expirationLte));
  }
  if (!rows.length) {
    throw new Error(
      `No Tradier sandbox chain for ${symbol} in the ${expirationGte ?? "?"}..${expirationLte ?? "?"} window`,
    );
  }
  const quoteJson = await tradierGet(token, "/markets/quotes", { symbols: symbol, greeks: "false" });
  const quote = mapTradierQuote(quoteJson);
  const contracts: ChainContract[] = rows.map((r) => ({
    kind: r.kind,
    strike: r.strike,
    openInterest: r.openInterest,
  }));
  return {
    ticker: symbol,
    contractsList: rows,
    maxPain: calculateMaxPain(contracts),
    underlyingPrice: quote.price,
    dayChange: null,
    dayChangePct: quote.changePct,
  };
}
