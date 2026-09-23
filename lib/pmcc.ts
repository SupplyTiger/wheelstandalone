// PMCC (poor man's covered call) gates, Wheel Rules v2.1.
//
// Short-leg evaluation order (hard blocks return a reason string for the UI):
//   Gate 0 Concentration (delta-adjusted LEAPS notional)
//   Gate 0.2 Factor cap (skipped while the cap is an open decision / null)
//   Gate 1.5 Gamma regime (ADVISORY for calls - never blocks)
//   Max Pain (short strike must be above max pain)
//   Rule 6 (green day)
//   Earnings (7-day blackout, short leg only - the LEAPS may hold through earnings)
//   Width Rule
//   LEAPS Delta Floor (no new short if LEAPS delta < 0.50)
//   Naked Ban (amended - long call counts as cover)
//   Instrument Ban
// followed by non-blocking advisories (short delta / DTE band, LEAPS delta / DTE at entry).

import {
  checkConcentrationGate,
  checkEarningsGate,
  checkInstrumentBanGate,
  checkMaxPainGate,
  checkNakedBanGate,
  checkRule6Gate,
  currency,
  verdictFor,
  type GateResult,
  type LongCallLeg,
  type MarketDirection,
  type NakedBanResult,
} from "./gates";
import { loadWheelRules, type WheelRules } from "./rules";

export type LeapsLeg = LongCallLeg & {
  /** Current delta of the LEAPS (0-1). */
  delta: number | null;
  /** Days to expiry today. */
  dte: number;
  /** Debit paid per contract, in dollars (e.g. 30.00 x 100 = 3000). */
  costPerContract: number;
};

export type ShortCallCandidate = {
  strike: number;
  expiry: string;
  dte: number;
  contracts: number;
  delta: number | null;
  /** Credit per contract in dollars (e.g. 1.20 x 100 = 120). */
  creditPerContract: number;
};

export type PmccShortLegInput = {
  ticker: string;
  spot: number;
  marketDirection: MarketDirection;
  maxPain: number | null;
  daysToEarnings: number | null;
  leaps: LeapsLeg;
  /** Credits already banked from prior shorts against this LEAPS, per contract, in dollars. */
  cumulativeShortCredits: number;
  short: ShortCallCandidate;
  /** Other long calls on the underlying (the LEAPS above is always included for coverage). */
  otherLongCalls?: LongCallLeg[];
  sharesOwned?: number;
  accountValue?: number;
  /** Existing exposure to this ticker in dollars (excluding this PMCC's LEAPS). */
  currentTickerValue?: number;
  /** Gate 0.2 inputs - both required for the gate to run. */
  factorExposurePct?: number | null;
  /** Gate 1.5 input - price at which dealer gamma flips; null = no data, gate skipped. */
  gammaFlip?: number | null;
  /** Is this the LEAPS purchase itself (entry)? Enables the LEAPS entry advisories. */
  isEntry?: boolean;
};

export type PmccChecklist = {
  results: GateResult[];
  verdict: "APPROVED" | "BLOCKED";
  advisories: string[];
  /** LEAPS locked by the Naked Ban once this short is open. */
  leapsLocked: boolean;
};

/** Delta-adjusted notional of the LEAPS: delta x 100 x spot x contracts. */
export function deltaAdjustedNotional(delta: number, spot: number, contracts: number): number {
  return Math.abs(delta) * 100 * spot * contracts;
}

/** Net debit per contract = LEAPS cost - all short credits banked so far. */
export function pmccNetDebit(leapsCostPerContract: number, cumulativeShortCredits: number): number {
  return leapsCostPerContract - cumulativeShortCredits;
}

/** Width Rule: short strike must be >= LEAPS strike + netDebit / 100. */
export function checkWidthRule(input: {
  leapsStrike: number;
  leapsCostPerContract: number;
  cumulativeShortCredits: number;
  shortStrike: number;
}): GateResult {
  const netDebit = pmccNetDebit(input.leapsCostPerContract, input.cumulativeShortCredits);
  const floor = input.leapsStrike + netDebit / 100;
  if (input.shortStrike < floor - 1e-9) {
    return {
      passed: false,
      gateName: "Width Rule",
      reason: `Short ${currency(input.shortStrike)} below LEAPS strike + net debit = ${currency(floor)} (assignment would lock a loss)`,
    };
  }
  return { passed: true, gateName: "Width Rule" };
}

/** No new short call if the LEAPS delta has decayed below the stop-writing floor. */
export function checkLeapsDeltaFloor(leapsDelta: number | null, rules: WheelRules = loadWheelRules()): GateResult {
  const floor = rules.pmcc.leaps.stopWritingDelta;
  if (leapsDelta === null) return { passed: true, gateName: "LEAPS Delta Floor" };
  if (Math.abs(leapsDelta) < floor - 1e-9) {
    return {
      passed: false,
      gateName: "LEAPS Delta Floor",
      reason: `LEAPS delta ${Math.abs(leapsDelta).toFixed(2)} below ${floor.toFixed(2)} - stop writing calls`,
    };
  }
  return { passed: true, gateName: "LEAPS Delta Floor" };
}

/** Gate 0.2 - skipped (null) while the factor cap number is an open decision. */
export function checkFactorCapGate(exposurePct: number | null | undefined, rules: WheelRules = loadWheelRules()): GateResult | null {
  const cap = rules.gate02.factorCapPct;
  if (cap === null || exposurePct === null || exposurePct === undefined) return null;
  if (exposurePct > cap) {
    return { passed: false, gateName: "Factor Cap", reason: `Factor exposure ${exposurePct.toFixed(1)}% exceeds ${cap}% cap` };
  }
  return { passed: true, gateName: "Factor Cap" };
}

/** Gate 1.5 for calls: advisory only, never blocks. */
export function gammaRegimeAdvisory(spot: number, gammaFlip: number | null | undefined): GateResult | null {
  if (gammaFlip === null || gammaFlip === undefined) return null;
  if (spot <= gammaFlip) {
    return {
      passed: true,
      advisory: true,
      gateName: "Gamma Regime",
      reason: `Spot ${currency(spot)} at/below gamma flip ${currency(gammaFlip)} - negative-gamma regime`,
    };
  }
  return null;
}

function bandAdvisory(gateName: string, label: string, value: number | null, min: number, max: number, fmt: (n: number) => string): GateResult | null {
  if (value === null) return null;
  if (value < min - 1e-9 || value > max + 1e-9) {
    return { passed: true, advisory: true, gateName, reason: `${label} ${fmt(value)} outside ${fmt(min)}-${fmt(max)}` };
  }
  return null;
}

export function pmccAdvisories(input: PmccShortLegInput, rules: WheelRules = loadWheelRules()): GateResult[] {
  const out: GateResult[] = [];
  const s = rules.pmcc.short;
  const d2 = (n: number) => n.toFixed(2);
  const d0 = (n: number) => String(Math.round(n));
  const shortDelta = input.short.delta === null ? null : Math.abs(input.short.delta);
  const a1 = bandAdvisory("Short Delta Band", "Short delta", shortDelta, s.deltaAdvisory.min, s.deltaAdvisory.max, d2);
  const a2 = bandAdvisory("Short DTE Band", "Short DTE", input.short.dte, s.dteAdvisory.min, s.dteAdvisory.max, d0);
  if (a1) out.push(a1);
  if (a2) out.push(a2);
  if (input.isEntry) {
    const l = rules.pmcc.leaps;
    if (input.leaps.delta !== null && Math.abs(input.leaps.delta) < l.entryMinDelta - 1e-9) {
      out.push({ passed: true, advisory: true, gateName: "LEAPS Entry", reason: `LEAPS delta ${d2(Math.abs(input.leaps.delta))} below ${d2(l.entryMinDelta)} entry target` });
    }
    if (input.leaps.dte < l.entryMinDte) {
      out.push({ passed: true, advisory: true, gateName: "LEAPS Entry", reason: `LEAPS DTE ${input.leaps.dte} below ${l.entryMinDte} entry target` });
    }
  }
  return out;
}

/** Full PMCC short-leg checklist, in the v2.1 enforcement order. */
export function runPmccShortLegChecklist(input: PmccShortLegInput, rules: WheelRules = loadWheelRules()): PmccChecklist {
  const results: GateResult[] = [];
  const leapsDelta = input.leaps.delta ?? 0;

  // Gate 0 - delta-adjusted notional, not the debit.
  const conc = checkConcentrationGate(
    {
      ticker: input.ticker,
      kind: "call",
      strike: input.short.strike,
      maxPain: input.maxPain ?? 0,
      marketDirection: input.marketDirection,
      daysToEarnings: input.daysToEarnings,
      accountValue: input.accountValue,
      currentTickerValue: input.currentTickerValue ?? 0,
      newCapital: deltaAdjustedNotional(leapsDelta, input.spot, input.leaps.contracts),
    },
    rules,
  );
  if (conc) results.push(conc);

  const factor = checkFactorCapGate(input.factorExposurePct, rules);
  if (factor) results.push(factor);

  const gamma = gammaRegimeAdvisory(input.spot, input.gammaFlip);
  if (gamma) results.push(gamma);

  results.push(
    input.maxPain === null
      ? { passed: false, gateName: "Max Pain", reason: "Max pain unavailable for the short-leg expiry" }
      : checkMaxPainGate(input.short.strike, "call", input.maxPain),
  );
  results.push(checkRule6Gate("call", input.marketDirection));
  results.push(checkEarningsGate(input.daysToEarnings, rules)); // short leg only
  results.push(
    checkWidthRule({
      leapsStrike: input.leaps.strike,
      leapsCostPerContract: input.leaps.costPerContract,
      cumulativeShortCredits: input.cumulativeShortCredits,
      shortStrike: input.short.strike,
    }),
  );
  results.push(checkLeapsDeltaFloor(input.leaps.delta, rules));

  const longCalls: LongCallLeg[] = [
    { strike: input.leaps.strike, expiry: input.leaps.expiry, contracts: input.leaps.contracts },
    ...(input.otherLongCalls ?? []),
  ];
  const naked: NakedBanResult = checkNakedBanGate(-input.short.contracts, input.sharesOwned ?? 0, {
    shortStrike: input.short.strike,
    shortExpiry: input.short.expiry,
    longCalls,
  });
  results.push(naked);
  results.push(checkInstrumentBanGate(input.ticker, rules));

  results.push(...pmccAdvisories(input, rules));

  return {
    results,
    verdict: verdictFor(results) as "APPROVED" | "BLOCKED",
    advisories: results.filter((r) => r.advisory && r.reason).map((r) => r.reason as string),
    leapsLocked: naked.passed && (naked.lockedLongCallIdx ?? []).includes(0),
  };
}

/** Roll gate: max rolls, net credit required, and the new short must still pass the Width Rule. */
export function checkPmccRoll(
  input: {
    rollsSoFar: number;
    /** Net credit of the roll per contract in dollars (new credit - buyback cost). */
    rollNetCredit: number;
    newShortStrike: number;
    leapsStrike: number;
    leapsCostPerContract: number;
    cumulativeShortCredits: number;
  },
  rules: WheelRules = loadWheelRules(),
): GateResult[] {
  const out: GateResult[] = [];
  const max = rules.pmcc.rolls.max;
  out.push(
    input.rollsSoFar >= max
      ? { passed: false, gateName: "Roll Limit", reason: `Already rolled ${input.rollsSoFar}x - max ${max}, close instead` }
      : { passed: true, gateName: "Roll Limit" },
  );
  if (rules.pmcc.rolls.requireNetCredit) {
    out.push(
      input.rollNetCredit > 0
        ? { passed: true, gateName: "Roll Net Credit" }
        : { passed: false, gateName: "Roll Net Credit", reason: `Roll is a ${currency(input.rollNetCredit)} net debit - rolls must be for a credit` },
    );
  }
  out.push(
    checkWidthRule({
      leapsStrike: input.leapsStrike,
      leapsCostPerContract: input.leapsCostPerContract,
      // the roll's credit counts toward cumulative credits once filled
      cumulativeShortCredits: input.cumulativeShortCredits + Math.max(0, input.rollNetCredit),
      shortStrike: input.newShortStrike,
    }),
  );
  return out;
}

export type PmccRoiCard = {
  credit: number;
  netDebit: number;
  maxLoss: number;
  creditOverNetDebitPct: number | null;
  creditOverMaxLossPct: number | null;
  annualizedPct: number | null;
  dte: number;
  gates: Array<{ gateName: string; status: "pass" | "block" | "advisory"; reason?: string }>;
  verdict: "APPROVED" | "BLOCKED";
};

/** ROI card for a PMCC short: credit / net debit, credit / max loss (max loss = net debit), annualized. */
export function buildPmccRoiCard(input: {
  creditPerContract: number;
  leapsCostPerContract: number;
  cumulativeShortCredits: number;
  dte: number;
  contracts: number;
  checklist: PmccChecklist;
}): PmccRoiCard {
  const credit = input.creditPerContract * input.contracts;
  const netDebit = pmccNetDebit(input.leapsCostPerContract, input.cumulativeShortCredits) * input.contracts;
  const maxLoss = netDebit;
  const ratio = (n: number, d: number) => (d > 0 ? (n / d) * 100 : null);
  const raw = ratio(credit, netDebit);
  return {
    credit,
    netDebit,
    maxLoss,
    creditOverNetDebitPct: raw,
    creditOverMaxLossPct: ratio(credit, maxLoss),
    annualizedPct: raw !== null && input.dte > 0 ? (raw * 365) / input.dte : null,
    dte: input.dte,
    gates: input.checklist.results.map((r) => ({
      gateName: r.gateName,
      status: r.advisory ? "advisory" : r.passed ? "pass" : "block",
      reason: r.reason,
    })),
    verdict: input.checklist.verdict,
  };
}
