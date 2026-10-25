import { test } from "node:test";
import assert from "node:assert/strict";

import { callDelta, putDelta } from "../blackScholes";
import { findLongCall, findShortCall } from "../positions";
import {
  median,
  robustZScores,
  computeOutlierFlags,
  type MetricDef,
} from "../outliers";
import {
  daysToExpiry,
  midPrice,
  spreadPct,
  widthFloor,
  annualizedYield,
  concentrationBlock,
  PMCC_METRICS,
} from "../pmcc";

// --- blackScholes: callDelta is putDelta + 1 (put-call parity) ---

test("callDelta equals putDelta + 1 on identical inputs", () => {
  const spot = 650, strike = 550, dte = 450, iv = 0.45;
  const p = putDelta(spot, strike, dte, iv);
  const c = callDelta(spot, strike, dte, iv);
  assert.notEqual(p, null);
  assert.notEqual(c, null);
  assert.ok(Math.abs((c as number) - ((p as number) + 1)) < 1e-9);
  assert.ok((c as number) > 0.7 && (c as number) < 1); // deep ITM LEAPS-like
});

test("callDelta returns null on the same bad inputs as putDelta", () => {
  assert.equal(callDelta(null, 600, 450, 0.45), null);
  assert.equal(callDelta(650, 600, 450, 0), null);
  assert.equal(callDelta(650, 600, 0, 0.45), null);
});

// --- positions: long/short call finders ---

const book = [
  { ticker: "META", kind: "call" as const, side: "long" as const, quantity: 1, strike: 750, expiry: "2028-01-21" },
  { ticker: "META", kind: "call" as const, side: "short" as const, quantity: 1, strike: 850, expiry: "2027-03-19" },
  { ticker: "META", kind: "put" as const, side: "short" as const, quantity: 1, strike: 280, expiry: "2026-11-20" },
];

test("findLongCall finds the held long call, findShortCall the open short", () => {
  assert.equal(findLongCall(book, "META")?.strike, 750);
  assert.equal(findShortCall(book, "META")?.strike, 850);
  assert.equal(findLongCall(book, "NVDA"), null);
  assert.equal(findShortCall(book, "NVDA"), null);
});

// --- outliers: median, robust z, flagging ---

test("median handles odd, even, and empty populations", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), null);
});

test("robust z never flags a tiny or flat population", () => {
  const tiny = robustZScores([5, 9]);
  assert.ok((tiny[0] as number) < 0 && (tiny[1] as number) > 0);
  assert.ok(Math.abs(tiny[0] as number) < 2 && Math.abs(tiny[1] as number) < 2);
  assert.deepEqual(robustZScores([7, 7, 7, 7]), [0, 0, 0, 0]); // truly flat
  assert.deepEqual(robustZScores([null, null]), [null, null]);
});

test("majority-identical population still flags the far value (MAD fallback)", () => {
  const zs = robustZScores([10, 10, 10, 10, 10, 10, 10, 100]);
  assert.equal(zs[0], 0);
  assert.ok((zs[7] as number) >= 2);
});

test("computeOutlierFlags respects each metric's good side and threshold", () => {
  type Item = { a: number | null; b: number | null };
  const items: Item[] = [
    { a: 10, b: 50 }, { a: 10, b: 50 }, { a: 10, b: 50 }, { a: 10, b: 50 },
    { a: 10, b: 50 }, { a: 10, b: 50 }, { a: 10, b: 50 }, { a: 100, b: 1 },
  ];
  const metrics: Array<MetricDef<Item>> = [
    { key: "a", label: "A", get: (x) => x.a, good: "high" },
    { key: "b", label: "B", get: (x) => x.b, good: "low" },
  ];
  const flags = computeOutlierFlags(items, metrics, 2);
  assert.equal(flags[0].length, 0);
  assert.equal(flags[7].length, 2);
  const byKey = Object.fromEntries(flags[7].map((f) => [f.metric, f]));
  assert.equal(byKey.a.direction, "high");
  assert.equal(byKey.a.goodSide, "high");
  assert.equal(byKey.b.direction, "low");
  assert.equal(byKey.b.goodSide, "low");
});

test("computeOutlierFlags skips nulls instead of treating them as zero", () => {
  type Item = { a: number | null };
  const items: Item[] = [
    { a: 10 }, { a: 10 }, { a: 10 }, { a: 10 }, { a: 10 }, { a: 10 }, { a: 10 }, { a: null },
  ];
  const flags = computeOutlierFlags(items, [{ key: "a", label: "A", get: (x) => x.a, good: "high" }], 2);
  assert.ok(flags.every((f) => f.length === 0));
});

// --- pmcc pure helpers ---

test("midPrice requires a two-sided quote with ask >= bid", () => {
  assert.equal(midPrice(1.0, 1.2), 1.1);
  assert.equal(midPrice(1.0, null), null);
  assert.equal(midPrice(null, 1.2), null);
  assert.equal(midPrice(1.2, 1.0), null); // crossed
});

test("spreadPct is (ask-bid)/mid as a percent", () => {
  const s = spreadPct(1.0, 1.2);
  assert.notEqual(s, null);
  assert.ok(Math.abs((s as number) - 18.1818) < 0.001);
  assert.equal(spreadPct(1.0, null), null);
});

test("widthFloor is LEAPS strike + net debit per share", () => {
  assert.equal(widthFloor(750, 148.44), 898.44);
  assert.equal(widthFloor(600, 91.9), 691.9);
});

test("annualizedYield annualizes premium vs LEAPS debit", () => {
  const y = annualizedYield(500, 9190, 35);
  assert.notEqual(y, null);
  assert.ok(Math.abs((y as number) - 56.7) < 0.2);
  assert.equal(annualizedYield(500, 0, 35), null);
  assert.equal(annualizedYield(500, 9190, 0), null);
});

test("concentrationBlock mirrors the 30% cap wording", () => {
  assert.equal(concentrationBlock("META", 83275, 10000, 9190), null); // 23.0% passes
  const blocked = concentrationBlock("META", 83275, 28000, 9190); // 44.7% blocks
  assert.ok(blocked !== null && blocked.includes("44.7%") && blocked.includes("30% limit"));
  assert.equal(concentrationBlock("META", 0, 28000, 9190), null); // unknown account value skips
});

test("daysToExpiry returns whole days from today", () => {
  const future = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
  const d = daysToExpiry(future);
  assert.notEqual(d, null);
  assert.ok((d as number) >= 39 && (d as number) <= 41);
  assert.equal(daysToExpiry("not-a-date"), null);
});

// --- PMCC metric registry: the four required metrics, one entry each ---

test("PMCC_METRICS carries the four required outlier metrics", () => {
  const keys = PMCC_METRICS.map((m) => m.key);
  for (const required of ["ivTermSpread", "shortAnnYield", "leapsExtrinsicPerDelta", "callPutSkew"]) {
    assert.ok(keys.includes(required), `missing metric ${required}`);
  }
  // Adding a metric must be a one-line registry entry: every entry needs only
  // these four fields, nothing else to wire.
  for (const m of PMCC_METRICS) {
    assert.equal(typeof m.key, "string");
    assert.equal(typeof m.label, "string");
    assert.equal(typeof m.get, "function");
    assert.ok(["high", "low", "either"].includes(m.good));
  }
});
