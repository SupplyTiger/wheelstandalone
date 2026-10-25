import { test } from "node:test";
import assert from "node:assert/strict";

import {
  withYahooRetry,
  chainCacheKey,
  clearChainCache,
  chainCacheSize,
  type OptionsSummary,
} from "../yahooMarket";
import { parseCboeSymbol, mapCboePayload } from "../cboe";
import {
  mapTradierExpirations,
  mapTradierChain,
  mapTradierQuote,
  getTradierToken,
} from "../tradier";
import { fetchChainStack } from "../marketData";
import { chainSkipReason } from "../pmcc";

// --- withYahooRetry: flaky then fine ---------------------------------------

test("withYahooRetry retries a flaky source and returns the first success", async () => {
  let calls = 0;
  const value = await withYahooRetry(async () => {
    calls += 1;
    if (calls < 3) throw new Error(`boom ${calls}`);
    return "ok";
  });
  assert.equal(value, "ok");
  assert.equal(calls, 3);
});

test("withYahooRetry throws the LAST error after exhausting attempts", async () => {
  let calls = 0;
  await assert.rejects(
    withYahooRetry(async () => {
      calls += 1;
      throw new Error(`fail ${calls}`);
    }, 2),
    /fail 2/,
  );
  assert.equal(calls, 2);
});

// --- chain cache: keying + clearing -----------------------------------------
// NOTE: fetchOptionsSummaryResilient wraps the REAL Yahoo fetch, so the
// cache tests below assert bookkeeping only (key shape, size, clear) —
// never a live Yahoo call. Live cache/coalescing behavior is verified by
// the sandbox run, not here.

test("chainCacheKey is stable per ticker+window and case-insensitive", () => {
  assert.equal(chainCacheKey("meta", "2026-01-01", "2026-02-01"), "META|2026-01-01|2026-02-01");
  assert.equal(chainCacheKey("META", "2026-01-01", "2026-02-01"), "META|2026-01-01|2026-02-01");
  assert.notEqual(
    chainCacheKey("META", "2026-01-01", "2026-02-01"),
    chainCacheKey("META", "2026-01-01", "2026-03-01"),
  );
});

test("clearChainCache empties the cache", () => {
  clearChainCache();
  assert.equal(chainCacheSize(), 0);
});

// --- CBOE symbol parsing ----------------------------------------------------

test("parseCboeSymbol parses OCC symbols and rejects junk", () => {
  assert.deepEqual(parseCboeSymbol("META261026C00510000"), {
    expiry: "2026-10-26",
    kind: "call",
    strike: 510,
  });
  assert.deepEqual(parseCboeSymbol("META280121P00075000"), {
    expiry: "2028-01-21",
    kind: "put",
    strike: 75,
  });
  assert.equal(parseCboeSymbol("not-a-symbol"), null);
  assert.equal(parseCboeSymbol(""), null);
});

// --- CBOE payload mapping (fixture shaped like the live feed) ---------------

const CBOE_FIXTURE = {
  timestamp: "2026-10-25 00:30:43",
  data: {
    symbol: "META",
    current_price: 642.62,
    price_change: -12.1,
    price_change_percent: -1.85,
    options: [
      { option: "META261120C00650000", bid: 5.1, ask: 5.6, last_trade_price: 5.3, volume: 12, open_interest: 100, iv: 0.42, delta: 0.3 },
      { option: "META261120P00650000", bid: 4.2, ask: 4.7, last_trade_price: 4.4, volume: 8, open_interest: 80, iv: 0.4, delta: -0.3 },
      { option: "META280121C00750000", bid: 90.0, ask: 95.0, last_trade_price: 92.0, volume: 3, open_interest: 50, iv: 0.38, delta: 0.8 },
      { option: "GARBAGE", bid: 1, ask: 2, last_trade_price: 1, volume: 0, open_interest: 0, iv: 0.5 },
    ],
  },
};

test("mapCboePayload filters to the window, skips junk, keeps IV and OI", () => {
  const summary = mapCboePayload(CBOE_FIXTURE as never, "META", "2026-11-01", "2026-12-31");
  assert.equal(summary.ticker, "META");
  assert.equal(summary.underlyingPrice, 642.62);
  assert.equal(summary.dayChangePct, -1.85);
  // Only the two Nov-2026 contracts survive; the Jan-2028 LEAPS and the
  // garbage symbol are out.
  assert.equal(summary.contractsList.length, 2);
  const call = summary.contractsList.find((c) => c.kind === "call");
  assert.equal(call?.strike, 650);
  assert.equal(call?.expiry, "2026-11-20");
  assert.equal(call?.impliedVolatility, 0.42);
  assert.equal(call?.openInterest, 100);
  // Max pain is computable from the mapped rows (both strikes present).
  assert.notEqual(summary.maxPain, null);
});

test("mapCboePayload throws when the window holds nothing", () => {
  assert.throws(() => mapCboePayload(CBOE_FIXTURE as never, "META", "2030-01-01", "2030-12-31"), /No CBOE delayed chain/);
});

// --- Tradier mappers (fixtures shaped per Tradier's public REST docs) ------

test("mapTradierExpirations handles array and single-object shapes", () => {
  const arrayShape = { expirations: { expiration: [{ date: "2026-11-20" }, { date: "2028-01-21" }] } };
  assert.deepEqual(mapTradierExpirations(arrayShape), ["2026-11-20", "2028-01-21"]);
  const singleShape = { expirations: { expiration: { date: "2026-11-20" } } };
  assert.deepEqual(mapTradierExpirations(singleShape), ["2026-11-20"]);
  assert.deepEqual(mapTradierExpirations({}), []);
});

test("mapTradierChain maps greeks IV with mid -> bid fallback, filters window", () => {
  const chain = {
    options: {
      option: [
        { symbol: "META261120C00650000", type: "call", strike: 650, expiration_date: "2026-11-20", bid: 5.1, ask: 5.6, last: 5.3, volume: 12, open_interest: 100, greeks: { delta: 0.3, mid_iv: 0.42 } },
        { symbol: "META261120P00650000", type: "put", strike: 650, expiration_date: "2026-11-20", bid: 4.2, ask: 4.7, last: 4.4, volume: 8, open_interest: 80, greeks: { delta: -0.3, bid_iv: 0.4 } },
        { symbol: "META280121C00750000", type: "call", strike: 750, expiration_date: "2028-01-21", bid: 90, ask: 95, last: 92, volume: 3, open_interest: 50, greeks: { delta: 0.8 } },
      ],
    },
  };
  const rows = mapTradierChain(chain, "META", "2026-11-01", "2026-12-31");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].impliedVolatility, 0.42); // mid_iv wins
  assert.equal(rows[1].impliedVolatility, 0.4); // bid_iv fallback
  // The Jan-2028 contract is outside the window.
  assert.ok(rows.every((r) => r.expiry === "2026-11-20"));
});

test("mapTradierQuote reads last price and change percent", () => {
  const quote = { quotes: { quote: { last: 642.62, close: 640.0, change_percentage: -1.85 } } };
  assert.deepEqual(mapTradierQuote(quote), { price: 642.62, changePct: -1.85 });
  assert.deepEqual(mapTradierQuote({}), { price: null, changePct: null });
});

test("getTradierToken is null without the env var (dormant leg)", () => {
  const saved = process.env.TRADIER_SANDBOX_TOKEN;
  delete process.env.TRADIER_SANDBOX_TOKEN;
  try {
    assert.equal(getTradierToken(), null);
  } finally {
    if (saved !== undefined) process.env.TRADIER_SANDBOX_TOKEN = saved;
  }
});

// --- Stack ordering (injected fakes — no network) ---------------------------

function fakeSummary(ticker: string): OptionsSummary {
  return {
    ticker,
    contractsList: [],
    maxPain: null,
    underlyingPrice: 100,
    dayChange: null,
    dayChangePct: null,
  };
}

test("fetchChainStack tries Yahoo, then CBOE, and reports the Yahoo error", async () => {
  const result = await fetchChainStack("META", "2026-11-01", "2026-11-30", {
    yahoo: async () => {
      throw new Error("yahoo 429 throttled");
    },
    cboe: async (t) => fakeSummary(t),
    tradier: async () => {
      throw new Error("should not be reached");
    },
  });
  assert.equal(result.source, "cboe");
  assert.deepEqual(result.sourceErrors, ["yahoo: yahoo 429 throttled"]);
});

test("fetchChainStack prefers Yahoo when it wins and reports no errors", async () => {
  const result = await fetchChainStack("META", undefined, undefined, {
    yahoo: async (t) => fakeSummary(t),
    cboe: async () => {
      throw new Error("should not be reached");
    },
  });
  assert.equal(result.source, "yahoo");
  assert.deepEqual(result.sourceErrors, []);
});

test("fetchChainStack throws ONE error carrying all three sources", async () => {
  await assert.rejects(
    fetchChainStack("META", undefined, undefined, {
      yahoo: async () => {
        throw new Error("yahoo down");
      },
      cboe: async () => {
        throw new Error("cboe reshaped");
      },
      tradier: async () => {
        throw new Error("Tradier sandbox dormant: TRADIER_SANDBOX_TOKEN is not set");
      },
    }),
    (error: unknown) => {
      const msg = error instanceof Error ? error.message : "";
      return (
        msg.includes("yahoo: yahoo down") &&
        msg.includes("cboe: cboe reshaped") &&
        msg.includes("tradier: Tradier sandbox dormant")
      );
    },
  );
});

// --- PMCC skip reason surfacing ----------------------------------------------

test("chainSkipReason names both windows' errors instead of a bare skip", () => {
  const reason = chainSkipReason("yahoo 429", "cboe HTTP 404");
  assert.ok(reason.includes("short window: yahoo 429"));
  assert.ok(reason.includes("LEAPS window: cboe HTTP 404"));
  assert.equal(
    chainSkipReason(null, null),
    "No option chain returned for the short or LEAPS window",
  );
});
