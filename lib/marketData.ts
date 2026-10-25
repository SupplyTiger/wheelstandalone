// MARKET-DATA STACK (Oct 2026) — one chain fetch, three layers, in order.
//
// WHY: production /api/pmcc-screener returned bare Yahoo skips while
// /api/screener worked from Vercel seconds apart — Yahoo throttling
// Vercel's shared egress, worsened by the PMCC route's concurrent burst.
// The stack fixes the burst at the source (the PMCC route now fetches
// sequentially) and gives every ticker two more chances before it skips.
//
// LAYERS, in priority order:
//   1. Yahoo (resilient): yahoo-finance2 via lib/yahooMarket.ts, with
//      retry + backoff + a 5-minute cache with request coalescing.
//   2. CBOE delayed: cdn.cboe.com delayed quotes (~15 min delayed, no
//      signup, no key). Verified live Oct 2026 — full chain, bid/ask,
//      IV, Greeks, open interest, underlying price.
//   3. Tradier sandbox: free developer sandbox, ~15 min delayed chains.
//      DORMANT without TRADIER_SANDBOX_TOKEN — no token, no call, and
//      the stack records "dormant" instead of an error, so a reader can
//      tell "not configured" apart from "tried and failed".
//
// ALL THREE LAYERS ARE SCREENING-GRADE DELAYED-ISH DATA. Yahoo is the
// freshest of the three; CBOE and Tradier are ~15 minutes delayed.
// That is fine for a screener (candidates for review, never a fill
// verification) and is stated in the response's dataNote, not hidden.
//
// SCOPE DISCIPLINE: only the PMCC route uses this stack. The CSP route
// keeps calling fetchOptionsSummary directly — its behavior is
// byte-identical, proven by the unchanged blind-AMZN check. Bars and
// earnings stay on Yahoo (bars failing is already non-fatal, earnings
// failing is already null-tolerant).
//
// FAILURE CONTRACT: on success, returns the chain plus which source won
// and every earlier source's error message. On total failure, throws ONE
// error carrying all three sources' messages, so the PMCC row's
// skipReason names the actual problem instead of "No option chain".

import { fetchCboeChain } from "./cboe";
import { fetchTradierChain } from "./tradier";
import { fetchOptionsSummaryResilient, type OptionsSummary } from "./yahooMarket";

export type ChainSource = "yahoo" | "cboe" | "tradier";

export type ChainStackResult = {
  summary: OptionsSummary;
  source: ChainSource;
  /** Earlier sources' error messages, in try order. Empty when Yahoo won. */
  sourceErrors: string[];
};

export type ChainFetcher = (
  ticker: string,
  expirationGte?: string,
  expirationLte?: string,
) => Promise<OptionsSummary>;

/** Injectable sources — production defaults are the real three layers. */
export type ChainStackDeps = {
  yahoo?: ChainFetcher;
  cboe?: ChainFetcher;
  tradier?: ChainFetcher;
};

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown chain fetch error";
}

export async function fetchChainStack(
  ticker: string,
  expirationGte?: string,
  expirationLte?: string,
  deps: ChainStackDeps = {},
): Promise<ChainStackResult> {
  const symbol = ticker.trim().toUpperCase();
  const yahoo = deps.yahoo ?? fetchOptionsSummaryResilient;
  const cboe = deps.cboe ?? fetchCboeChain;
  const tradier = deps.tradier ?? fetchTradierChain;

  const errors: string[] = [];
  try {
    const summary = await yahoo(symbol, expirationGte, expirationLte);
    return { summary, source: "yahoo", sourceErrors: [] };
  } catch (error) {
    errors.push(`yahoo: ${errMessage(error)}`);
  }
  try {
    const summary = await cboe(symbol, expirationGte, expirationLte);
    return { summary, source: "cboe", sourceErrors: errors };
  } catch (error) {
    errors.push(`cboe: ${errMessage(error)}`);
  }
  try {
    const summary = await tradier(symbol, expirationGte, expirationLte);
    return { summary, source: "tradier", sourceErrors: errors };
  } catch (error) {
    errors.push(`tradier: ${errMessage(error)}`);
  }
  throw new Error(`All chain sources failed for ${symbol} — ${errors.join(" | ")}`);
}
