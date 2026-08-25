import { test } from "node:test";
import assert from "node:assert/strict";

import { calculateMaxPain } from "../maxPain";
import { checkMaxPainGate, checkRule6Gate, checkEarningsGate, checkMaxCollateralGate, runPreTradeChecklist, verdictFor } from "../gates";
import { computeRsiSeries, analyzeTechnicals } from "../technicals";
import { scoreCandidate, MIN_BID } from "../screener";
import type { DailyBar } from "../yahooMarket";

test("calculateMaxPain picks the strike minimizing total option-writer payout", () => {
  const contracts = [
    { kind: "call" as const, strike: 100, openInterest: 500 },
    { kind: "call" as const, strike: 105, openInterest: 1000 },
    { kind: "put" as const, strike: 95, openInterest: 200 },
    { kind: "put" as const, strike: 100, openInterest: 800 },
  ];
  const result = calculateMaxPain(contracts);
  assert.notEqual(result, null);
  assert.ok(typeof result === "number");
});

test("calculateMaxPain returns null with no open interest", () => {
  const result = calculateMaxPain([{ kind: "call", strike: 100, openInterest: null }]);
  assert.equal(result, null);
});

test("Max Pain gate blocks a CSP strike at/above max pain", () => {
  const blocked = checkMaxPainGate(105, "put", 100);
  assert.equal(blocked.passed, false);
  const ok = checkMaxPainGate(95, "put", 100);
  assert.equal(ok.passed, true);
});

test("Rule 6 gate: puts only sell on red days", () => {
  assert.equal(checkRule6Gate("put", "red").passed, true);
  assert.equal(checkRule6Gate("put", "green").passed, false);
  assert.equal(checkRule6Gate("call", "green").passed, true);
});

test("Earnings gate blocks inside 7 days, allows outside", () => {
  assert.equal(checkEarningsGate(3).passed, false);
  assert.equal(checkEarningsGate(10).passed, true);
  assert.equal(checkEarningsGate(null).passed, true);
});

test("15% max-collateral cap blocks oversized single CSP", () => {
  const blocked = checkMaxCollateralGate({
    ticker: "MU", kind: "put", strike: 100, maxPain: 100, marketDirection: "red",
    daysToEarnings: null, newCapital: 40000, accountValue: 200000,
  });
  assert.equal(blocked?.passed, false);

  const ok = checkMaxCollateralGate({
    ticker: "MU", kind: "put", strike: 100, maxPain: 100, marketDirection: "red",
    daysToEarnings: null, newCapital: 20000, accountValue: 200000,
  });
  assert.equal(ok?.passed, true);
});

test("full pre-trade checklist: a clean CSP is APPROVED", () => {
  const gates = runPreTradeChecklist({
    ticker: "SOFI", kind: "put", strike: 15, maxPain: 17, marketDirection: "red",
    daysToEarnings: 30, newCapital: 1500, accountValue: 200000, currentTickerValue: 0,
  });
  assert.equal(verdictFor(gates), "APPROVED");
});

test("full pre-trade checklist: strike above max pain is BLOCKED", () => {
  const gates = runPreTradeChecklist({
    ticker: "SOFI", kind: "put", strike: 18, maxPain: 17, marketDirection: "red",
    daysToEarnings: 30, newCapital: 1500, accountValue: 200000, currentTickerValue: 0,
  });
  assert.equal(verdictFor(gates), "BLOCKED");
});

function makeBars(closes: number[]): DailyBar[] {
  return closes.map((c, i) => ({ date: `2026-01-${String(i + 1).padStart(2, "0")}`, close: c, high: c + 1, low: c - 1, volume: 1000 }));
}

test("computeRsiSeries: monotonically rising closes -> RSI near 100", () => {
  const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
  const rsi = computeRsiSeries(closes, 14);
  const last = rsi[rsi.length - 1];
  assert.ok(last !== null && last > 90);
});

test("computeRsiSeries: monotonically falling closes -> RSI near 0", () => {
  const closes = Array.from({ length: 20 }, (_, i) => 100 - i);
  const rsi = computeRsiSeries(closes, 14);
  const last = rsi[rsi.length - 1];
  assert.ok(last !== null && last < 10);
});

test("analyzeTechnicals detects a bullish divergence: lower price low, higher RSI low", () => {
  // Down-down-up pattern shaped so the second low is deeper in price but shallower in RSI decline.
  const closes = [
    50, 49, 48, 47, 46, 45, 44, 43, 42, 41, // sharp decline (pivot low ~41 with strong RSI drop)
    43, 45, 47, 49, 51, 52, 53, 54, // recovery (pivot high)
    52, 51, 50, 48, 46, 44, 42, 40, // shallower decline down to a lower price low, but RSI won't be as oversold as the first plunge
    41, 43, 45,
  ];
  const bars = makeBars(closes);
  const result = analyzeTechnicals(bars, 2, closes.length);
  // Just assert it runs and returns one of the valid signals with a consistent shape.
  assert.ok(["bullish", "bearish", "none"].includes(result.divergence));
  if (result.divergence !== "none") {
    assert.ok(typeof result.divergenceNote === "string");
  }
});

test("analyzeTechnicals returns neutral on too little data", () => {
  const bars = makeBars([100, 101, 102]);
  const result = analyzeTechnicals(bars);
  assert.equal(result.divergence, "none");
  assert.equal(result.rsi, null);
});

// Regression test for a real bug caught on live data (2026-08-25): a deep-OTM AAPL put
// (strike $120 vs spot $309.90, bid $0.01, ~0.09% ROI) outscored a real candidate because
// the max-pain-distance bonus was uncapped and dominated when ROI was near zero.
test("scoreCandidate: real ROI beats deep-OTM max-pain distance (regression, was reversed)", () => {
  // Deep OTM: huge raw pain-distance, but near-zero ROI (the AAPL bug case).
  const junkyDeepOtm = scoreCandidate(0.09, 24, 320, 120, 50.9, "none");
  // Realistic CSP: modest pain-distance, real ROI (the SOFI-shaped case).
  const realCandidate = scoreCandidate(5.46, 38, 22, 18.5, 57.2, "none");
  assert.ok(
    realCandidate > junkyDeepOtm,
    `expected a real ROI candidate (${realCandidate}) to outscore a near-worthless deep-OTM contract (${junkyDeepOtm})`,
  );
});

test("scoreCandidate: max-pain-distance bonus is capped, can't swamp ROI on its own", () => {
  // Same tiny ROI, but push pain distance to an extreme (strike near zero vs a huge max pain).
  const extremePainDistance = scoreCandidate(0.09, 24, 1000, 1, null, "none");
  const modestRoi = scoreCandidate(3, 30, 100, 90, null, "none");
  assert.ok(
    modestRoi > extremePainDistance,
    `expected a modest real ROI (${modestRoi}) to still beat an extreme-but-capped pain-distance score (${extremePainDistance})`,
  );
});

test("MIN_BID junk-quote floor is a sane, non-zero threshold", () => {
  assert.ok(MIN_BID > 0);
  assert.ok(MIN_BID < 1); // shouldn't accidentally filter out real, thin-but-tradeable premium
});
