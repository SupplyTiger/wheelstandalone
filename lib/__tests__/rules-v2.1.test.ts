import { test } from "node:test";
import assert from "node:assert/strict";

import { loadWheelRules, parseWheelRules } from "../rules";
import {
  adjustedCostBasis,
  checkCapitalDefenseGate,
  checkInstrumentBanGate,
  checkNakedBanGate,
  cspDeltaAdvisory,
  runPreTradeChecklist,
  verdictFor,
} from "../gates";
import {
  buildPmccRoiCard,
  checkFactorCapGate,
  checkLeapsDeltaFloor,
  checkPmccRoll,
  checkWidthRule,
  deltaAdjustedNotional,
  gammaRegimeAdvisory,
  runPmccShortLegChecklist,
  type PmccShortLegInput,
} from "../pmcc";
import { evaluateCspMonitors, evaluatePmccMonitors, type PmccSnapshot } from "../monitors";

const rules = loadWheelRules();

// ── Config ──────────────────────────────────────────────────────────────────

test("wheel-rules.yaml loads with v2.1 values and unchanged open-decision gates", () => {
  assert.equal(rules.version, "2.1");
  assert.equal(rules.gate0.singleNameCapPct, 30); // open decision, unchanged
  assert.equal(rules.gate02.factorCapPct, null); // open decision, gate skipped
  assert.equal(rules.maxCollateral.capPct, 15);
  assert.equal(rules.earnings.blackoutDays, 7);
  assert.deepEqual(rules.csp.profitTarget, { brokerage: 0.5, ira: 0.75 });
  assert.equal(rules.pmcc.leaps.stopWritingDelta, 0.5);
  assert.equal(rules.pmcc.rolls.max, 2);
  assert.ok(rules.instrumentBan.tickers.includes("SPCU"));
});

test("parseWheelRules rejects a missing threshold with the key name", () => {
  assert.throws(() => parseWheelRules("version: '2.1'\ngate0: {}\n"), /gate0\.singleNameCapPct/);
});

// ── Capital Defense (ACB) ───────────────────────────────────────────────────

test("ACB: assignment 80, lot premiums $900 -> ACB 71", () => {
  assert.equal(adjustedCostBasis({ assignmentStrike: 80, premiumsCollected: 900 }), 71);
});

test("Capital Defense: 72C passes vs ACB 71, 70C blocks; reason shows raw basis and ACB", () => {
  const lot = { assignmentStrike: 80, premiumsCollected: 900 };
  const pass = checkCapitalDefenseGate(72, lot);
  assert.equal(pass.passed, true);
  assert.match(pass.reason ?? "", /raw basis \$80\.00, ACB \$71\.00/);
  const block = checkCapitalDefenseGate(70, lot);
  assert.equal(block.passed, false);
  assert.match(block.reason ?? "", /raw basis \$80\.00, ACB \$71\.00/);
});

test("Capital Defense: legacy numeric basis still works (ACB == raw)", () => {
  assert.equal(checkCapitalDefenseGate(79, 80).passed, false);
  assert.equal(checkCapitalDefenseGate(80, 80).passed, true);
  assert.equal(checkCapitalDefenseGate(50, null).passed, true);
});

// ── Naked Ban (amended) ─────────────────────────────────────────────────────

const SHORT_EXP = "2026-10-16";

test("Naked Ban: long 100C Jan-27 covers short 110C Oct-26 -> pass, LEAPS locked", () => {
  const r = checkNakedBanGate(-1, 0, { shortStrike: 110, shortExpiry: SHORT_EXP, longCalls: [{ strike: 100, expiry: "2027-01-15", contracts: 1 }] });
  assert.equal(r.passed, true);
  assert.equal(r.coveredBy, "long-call");
  assert.deepEqual(r.lockedLongCallIdx, [0]);
});

test("Naked Ban: long 115C (strike above short 110C) -> block", () => {
  const r = checkNakedBanGate(-1, 0, { shortStrike: 110, shortExpiry: SHORT_EXP, longCalls: [{ strike: 115, expiry: "2027-01-15", contracts: 1 }] });
  assert.equal(r.passed, false);
  assert.ok(r.reason);
});

test("Naked Ban: long call expiring before the short -> block", () => {
  const r = checkNakedBanGate(-1, 0, { shortStrike: 110, shortExpiry: SHORT_EXP, longCalls: [{ strike: 100, expiry: "2026-09-18", contracts: 1 }] });
  assert.equal(r.passed, false);
});

test("Naked Ban: contract count must cover shorts; shares still cover alone", () => {
  const under = checkNakedBanGate(-2, 0, { shortStrike: 110, shortExpiry: SHORT_EXP, longCalls: [{ strike: 100, expiry: "2027-01-15", contracts: 1 }] });
  assert.equal(under.passed, false);
  assert.equal(checkNakedBanGate(-2, 200).passed, true);
  assert.equal(checkNakedBanGate(-2, 199).passed, false);
});

// ── Instrument Ban / CSP delta advisory ─────────────────────────────────────

test("Instrument Ban blocks leveraged/inverse ETFs, passes normal names", () => {
  assert.equal(checkInstrumentBanGate("spcu").passed, false);
  assert.equal(checkInstrumentBanGate("TQQQ").passed, false);
  assert.equal(checkInstrumentBanGate("AAPL").passed, true);
});

test("CSP delta advisory: outside 0.15-0.30 is advisory only, never blocks", () => {
  const low = cspDeltaAdvisory(-0.1);
  assert.ok(low && low.advisory && low.passed);
  assert.equal(cspDeltaAdvisory(-0.22), null);
  const gates = runPreTradeChecklist({
    ticker: "AAPL", kind: "put", strike: 150, maxPain: 160, marketDirection: "red",
    daysToEarnings: 30, newCapital: 15000, accountValue: 200000, currentTickerValue: 0, delta: -0.1,
  });
  assert.equal(verdictFor(gates), "APPROVED");
  assert.ok(gates.some((g) => g.advisory && g.gateName === "CSP Delta Band"));
});

// ── Width Rule ──────────────────────────────────────────────────────────────

test("Width Rule: LEAPS 100C @ $30 debit, short 125C -> block; 135C -> pass", () => {
  const base = { leapsStrike: 100, leapsCostPerContract: 3000, cumulativeShortCredits: 0 };
  assert.equal(checkWidthRule({ ...base, shortStrike: 125 }).passed, false);
  assert.equal(checkWidthRule({ ...base, shortStrike: 135 }).passed, true);
  assert.equal(checkWidthRule({ ...base, shortStrike: 130 }).passed, true); // boundary
});

test("Width Rule: banked short credits lower the floor", () => {
  // $30 debit - $6 banked = $24 net -> floor 124
  assert.equal(checkWidthRule({ leapsStrike: 100, leapsCostPerContract: 3000, cumulativeShortCredits: 600, shortStrike: 125 }).passed, true);
});

// ── LEAPS delta floor, factor cap, gamma advisory ───────────────────────────

test("LEAPS delta < 0.50 blocks a new short; >= 0.50 passes", () => {
  assert.equal(checkLeapsDeltaFloor(0.45).passed, false);
  assert.equal(checkLeapsDeltaFloor(0.5).passed, true);
  assert.equal(checkLeapsDeltaFloor(null).passed, true);
});

test("Gate 0.2 is skipped while the factor cap is null; blocks when a cap is set", () => {
  assert.equal(checkFactorCapGate(90), null);
  const withCap = { ...rules, gate02: { factorCapPct: 40 } };
  assert.equal(checkFactorCapGate(45, withCap)?.passed, false);
  assert.equal(checkFactorCapGate(35, withCap)?.passed, true);
});

test("Gate 1.5 for calls is advisory only", () => {
  const a = gammaRegimeAdvisory(95, 100);
  assert.ok(a && a.passed && a.advisory);
  assert.equal(gammaRegimeAdvisory(105, 100), null);
});

// ── Full PMCC short-leg checklist ───────────────────────────────────────────

function pmccInput(overrides: Partial<PmccShortLegInput> = {}): PmccShortLegInput {
  return {
    ticker: "AAPL",
    spot: 120,
    marketDirection: "green",
    maxPain: 125,
    daysToEarnings: 40,
    leaps: { strike: 100, expiry: "2027-12-17", contracts: 1, delta: 0.8, dte: 450, costPerContract: 3000 },
    cumulativeShortCredits: 0,
    short: { strike: 135, expiry: "2026-11-20", dte: 38, contracts: 1, delta: 0.3, creditPerContract: 150 },
    accountValue: 200000,
    currentTickerValue: 0,
    ...overrides,
  };
}

test("PMCC checklist: clean setup APPROVED, gates in v2.1 order, LEAPS locked", () => {
  const c = runPmccShortLegChecklist(pmccInput());
  assert.equal(c.verdict, "APPROVED");
  assert.equal(c.leapsLocked, true);
  assert.deepEqual(
    c.results.filter((r) => !r.advisory).map((r) => r.gateName),
    ["Concentration", "Max Pain", "Rule 6", "Earnings", "Width Rule", "LEAPS Delta Floor", "Naked Ban", "Instrument Ban"],
  );
});

test("PMCC checklist: each hard block surfaces a reason", () => {
  const cases: Array<[string, Partial<PmccShortLegInput>]> = [
    ["Max Pain", { maxPain: 140 }],
    ["Rule 6", { marketDirection: "red" }],
    ["Earnings", { daysToEarnings: 5 }],
    ["Width Rule", { short: { strike: 125, expiry: "2026-11-20", dte: 38, contracts: 1, delta: 0.3, creditPerContract: 150 }, maxPain: 120 }],
    ["LEAPS Delta Floor", { leaps: { strike: 100, expiry: "2027-12-17", contracts: 1, delta: 0.45, dte: 450, costPerContract: 3000 } }],
    ["Naked Ban", { leaps: { strike: 100, expiry: "2026-10-16", contracts: 1, delta: 0.8, dte: 20, costPerContract: 3000 } }],
    ["Instrument Ban", { ticker: "TQQQ" }],
    ["Concentration", { accountValue: 20000 }],
  ];
  for (const [gate, override] of cases) {
    const c = runPmccShortLegChecklist(pmccInput(override));
    const hit = c.results.find((r) => r.gateName === gate);
    assert.equal(c.verdict, "BLOCKED", gate);
    assert.equal(hit?.passed, false, gate);
    assert.ok(hit?.reason, `${gate} must have a reason`);
  }
});

test("PMCC concentration uses delta-adjusted notional, not debit", () => {
  assert.equal(deltaAdjustedNotional(0.8, 120, 1), 9600);
  // $3,000 debit would pass a $20K account at 30%, but 0.8 x 100 x 120 = $9,600 = 48% -> block
  const c = runPmccShortLegChecklist(pmccInput({ accountValue: 20000 }));
  assert.match(c.results.find((r) => r.gateName === "Concentration")?.reason ?? "", /48\.0%/);
});

test("PMCC advisories: short delta/DTE out of band and weak LEAPS at entry never block", () => {
  const c = runPmccShortLegChecklist(
    pmccInput({
      isEntry: true,
      short: { strike: 135, expiry: "2026-11-20", dte: 60, contracts: 1, delta: 0.2, creditPerContract: 150 },
      leaps: { strike: 100, expiry: "2027-06-17", contracts: 1, delta: 0.6, dte: 300, costPerContract: 3000 },
    }),
  );
  assert.equal(c.verdict, "APPROVED");
  assert.equal(c.advisories.length, 4);
});

// ── Rolls ───────────────────────────────────────────────────────────────────

test("PMCC roll: 3rd roll blocked, debit roll blocked, must pass Width Rule", () => {
  const base = { leapsStrike: 100, leapsCostPerContract: 3000, cumulativeShortCredits: 0, newShortStrike: 135, rollNetCredit: 50 };
  assert.ok(checkPmccRoll({ ...base, rollsSoFar: 1 }).every((r) => r.passed));
  assert.equal(checkPmccRoll({ ...base, rollsSoFar: 2 }).find((r) => r.gateName === "Roll Limit")?.passed, false);
  assert.equal(checkPmccRoll({ ...base, rollsSoFar: 0, rollNetCredit: -20 }).find((r) => r.gateName === "Roll Net Credit")?.passed, false);
  assert.equal(checkPmccRoll({ ...base, rollsSoFar: 0, newShortStrike: 120 }).find((r) => r.gateName === "Width Rule")?.passed, false);
});

// ── ROI card ────────────────────────────────────────────────────────────────

test("PMCC ROI card: credit/net debit, credit/max loss, annualized, per-gate status", () => {
  const checklist = runPmccShortLegChecklist(pmccInput());
  const card = buildPmccRoiCard({ creditPerContract: 150, leapsCostPerContract: 3000, cumulativeShortCredits: 0, dte: 38, contracts: 1, checklist });
  assert.equal(card.credit, 150);
  assert.equal(card.netDebit, 3000);
  assert.equal(card.maxLoss, 3000);
  assert.equal(card.creditOverNetDebitPct, 5);
  assert.equal(card.creditOverMaxLossPct, 5);
  assert.ok(Math.abs((card.annualizedPct ?? 0) - (5 * 365) / 38) < 1e-9);
  assert.ok(card.gates.every((g) => g.status === "pass"));
});

// ── Monitors ────────────────────────────────────────────────────────────────

function snap(o: Partial<PmccSnapshot> = {}): PmccSnapshot {
  return {
    ticker: "AAPL",
    spot: 120,
    leaps: { strike: 100, dte: 400, costPerShare: 30, markPerShare: 28 },
    short: { strike: 135, dte: 30, openCreditPerShare: 1.5, markPerShare: 1.2 },
    exDividend: null,
    ...o,
  };
}
const codes = (alerts: { code: string }[]) => alerts.map((a) => a.code).sort();

test("Monitor: short leg >= 50% decay -> Theta Sniper", () => {
  assert.deepEqual(codes(evaluatePmccMonitors(snap({ short: { strike: 135, dte: 30, openCreditPerShare: 1.5, markPerShare: 0.7 } }))), ["THETA_SNIPER"]);
  assert.deepEqual(codes(evaluatePmccMonitors(snap())), []);
});

test("Monitor: short <= 21 DTE without target -> Time stop", () => {
  assert.deepEqual(codes(evaluatePmccMonitors(snap({ short: { strike: 135, dte: 21, openCreditPerShare: 1.5, markPerShare: 1.2 } }))), ["TIME_STOP"]);
});

test("Monitor: spread >= 80% of width or extrinsic <= $0.15 -> Harvest", () => {
  // width 35; spread 30 - 2 = 28 = 80%
  const a = evaluatePmccMonitors(snap({ spot: 128, leaps: { strike: 100, dte: 400, costPerShare: 20, markPerShare: 30 }, short: { strike: 135, dte: 30, openCreditPerShare: 2.5, markPerShare: 2 } }));
  assert.ok(codes(a).includes("HARVEST_SPREAD"));
  const b = evaluatePmccMonitors(snap({ short: { strike: 135, dte: 30, openCreditPerShare: 0.3, markPerShare: 0.14 } }));
  assert.ok(codes(b).includes("HARVEST_SPREAD"));
});

test("Monitor: LEAPS <= 150 DTE -> Roll; LEAPS down >= 35% -> Review", () => {
  assert.ok(codes(evaluatePmccMonitors(snap({ leaps: { strike: 100, dte: 150, costPerShare: 30, markPerShare: 28 } }))).includes("ROLL_LEAPS"));
  assert.ok(codes(evaluatePmccMonitors(snap({ leaps: { strike: 100, dte: 400, costPerShare: 30, markPerShare: 19.5 } }))).includes("REVIEW_LEAPS"));
  assert.ok(!codes(evaluatePmccMonitors(snap({ leaps: { strike: 100, dte: 400, costPerShare: 30, markPerShare: 20 } }))).includes("REVIEW_LEAPS"));
});

test("Monitor: ITM short, ex-div within 5d, extrinsic < dividend -> Early assignment risk", () => {
  const itm = { strike: 115, dte: 30, openCreditPerShare: 6, markPerShare: 5.3 }; // spot 120 -> intrinsic 5, extrinsic 0.30
  assert.ok(codes(evaluatePmccMonitors(snap({ short: itm, exDividend: { daysAway: 3, amountPerShare: 0.5 } }))).includes("EARLY_ASSIGNMENT"));
  assert.ok(!codes(evaluatePmccMonitors(snap({ short: itm, exDividend: { daysAway: 8, amountPerShare: 0.5 } }))).includes("EARLY_ASSIGNMENT"));
  assert.ok(!codes(evaluatePmccMonitors(snap({ short: itm, exDividend: { daysAway: 3, amountPerShare: 0.2 } }))).includes("EARLY_ASSIGNMENT"));
});

test("CSP monitors: profit target 50% brokerage / 75% IRA, 21 DTE time stop", () => {
  const p = { ticker: "AMD", strike: 150, dte: 30, openCreditPerShare: 2, markPerShare: 0.9 }; // 55% captured
  assert.deepEqual(codes(evaluateCspMonitors({ ...p, account: "brokerage" })), ["THETA_SNIPER"]);
  assert.deepEqual(codes(evaluateCspMonitors({ ...p, account: "ira" })), []);
  assert.deepEqual(codes(evaluateCspMonitors({ ...p, account: "ira", dte: 21 })), ["TIME_STOP"]);
});
