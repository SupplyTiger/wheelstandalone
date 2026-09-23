// Pre-trade checklist gates for the Institutional Treasury Wheel.
// Originally ported from the "treasury-wheel-mobile" scaffold. Wheel Rules v2.1 (2026-09-23):
// thresholds now come from config/wheel-rules.yaml via lib/rules.ts; Capital Defense uses
// Adjusted Cost Basis; Naked Ban accepts a qualifying long call (PMCC) as cover; Instrument
// Ban and CSP delta advisory added. Advisory results have passed=true + advisory=true, so
// they never change the verdict.

import { loadWheelRules, type WheelRules } from "./rules";

export type OptionKind = "put" | "call";
export type MarketDirection = "red" | "green";

export type GateResult = {
  passed: boolean;
  gateName: string;
  reason?: string;
  /** Non-blocking warning. Always passed=true; shown in the UI, never changes the verdict. */
  advisory?: boolean;
};

export type ChecklistInput = {
  ticker: string;
  kind: OptionKind;
  strike: number;
  maxPain: number;
  marketDirection: MarketDirection;
  daysToEarnings: number | null;
  /** Raw per-share cost basis (assignment strike). Kept for display; Capital Defense uses ACB. */
  costBasis?: number | null;
  /** Lot data for Adjusted Cost Basis. When present, Capital Defense checks strike >= ACB. */
  lot?: ShareLot | null;
  /** Long calls on the same underlying, for PMCC coverage under the amended Naked Ban. */
  longCalls?: LongCallLeg[];
  /** Short call being evaluated (expiry needed for PMCC coverage). */
  shortCallExpiry?: string | null;
  shortCallQty?: number;
  sharesOwned?: number;
  newCapital?: number;
  accountValue?: number;
  currentTickerValue?: number;
  delta?: number | null;
};

export type ShareLot = {
  /** Per-share assignment strike (raw cost basis). */
  assignmentStrike: number;
  /** Total dollars of premium collected on this lot so far (CSP + every CC), for 100 shares. */
  premiumsCollected: number;
};

export type LongCallLeg = {
  strike: number;
  /** ISO date, YYYY-MM-DD. */
  expiry: string;
  contracts: number;
};

export function currency(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return "--";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

export function checkMaxPainGate(strike: number, kind: OptionKind, maxPain: number): GateResult {
  // Critical CSP invariant: short-put strike must be BELOW max pain (price pins toward
  // max pain, so you want it pulling away from your short put).
  if (kind === "put" && strike >= maxPain) {
    return {
      passed: false,
      gateName: "Max Pain",
      reason: `CSP strike ${currency(strike)} is at/above max pain ${currency(maxPain)}`,
    };
  }
  if (kind === "call" && strike <= maxPain) {
    return {
      passed: false,
      gateName: "Max Pain",
      reason: `CC strike ${currency(strike)} is at/below max pain ${currency(maxPain)}`,
    };
  }
  return { passed: true, gateName: "Max Pain" };
}

export function checkRule6Gate(kind: OptionKind, marketDirection: MarketDirection): GateResult {
  if (kind === "put" && marketDirection !== "red") {
    return { passed: false, gateName: "Rule 6", reason: "Sell CSPs on red days only" };
  }
  if (kind === "call" && marketDirection !== "green") {
    return { passed: false, gateName: "Rule 6", reason: "Sell CCs on green days only" };
  }
  return { passed: true, gateName: "Rule 6" };
}

export function checkEarningsGate(daysToEarnings: number | null, rules: WheelRules = loadWheelRules()): GateResult {
  if (daysToEarnings === null || Number.isNaN(daysToEarnings)) {
    return { passed: true, gateName: "Earnings" };
  }
  const window = rules.earnings.blackoutDays;
  if (daysToEarnings <= window) {
    return {
      passed: false,
      gateName: "Earnings",
      reason: `Earnings in ${daysToEarnings} DTE - within ${window}-day blackout`,
    };
  }
  return { passed: true, gateName: "Earnings" };
}

/** Adjusted Cost Basis = assignment strike - (all premiums collected on the lot) / 100. */
export function adjustedCostBasis(lot: ShareLot): number {
  return Number((lot.assignmentStrike - lot.premiumsCollected / 100).toFixed(4));
}

/**
 * Capital Defense (amended v2.1): CC strike floor is the Adjusted Cost Basis.
 * Accepts either a ShareLot (preferred) or a bare per-share basis (legacy callers, no premium
 * history - then ACB == raw basis). The reason string always shows raw basis and ACB.
 */
export function checkCapitalDefenseGate(ccStrike: number, basis: ShareLot | number | null | undefined): GateResult {
  if (basis === null || basis === undefined || (typeof basis === "number" && Number.isNaN(basis))) {
    return { passed: true, gateName: "Capital Defense" };
  }
  const lot: ShareLot = typeof basis === "number" ? { assignmentStrike: basis, premiumsCollected: 0 } : basis;
  const acb = adjustedCostBasis(lot);
  const detail = `raw basis ${currency(lot.assignmentStrike)}, ACB ${currency(acb)}`;
  if (ccStrike < acb) {
    return {
      passed: false,
      gateName: "Capital Defense",
      reason: `CC strike ${currency(ccStrike)} below Adjusted Cost Basis (${detail})`,
    };
  }
  return { passed: true, gateName: "Capital Defense", reason: `Strike at/above ACB (${detail})` };
}

export type NakedBanResult = GateResult & {
  coveredBy?: "shares" | "long-call" | "shares+long-call";
  /** Indices (into longCalls) of LEAPS now locked: no close/sell while the short is open. */
  lockedLongCallIdx?: number[];
};

/** A long call covers a short call if same underlying (caller's job), strike <= short strike, expiry later. */
export function longCallCovers(long: LongCallLeg, shortStrike: number, shortExpiry: string): boolean {
  return long.strike <= shortStrike && long.expiry > shortExpiry && long.contracts > 0;
}

/**
 * Naked Ban (amended v2.1). A short call passes if covered by >= 100 shares per contract, OR
 * by long calls on the same underlying with strike <= short strike and expiry after the short
 * expiry, with contract count >= shorts. Shares and qualifying longs may combine. Qualifying
 * longs used for cover are returned as locked.
 */
export function checkNakedBanGate(
  shortCallQty = 0,
  sharesOwned = 0,
  pmcc?: { shortStrike: number; shortExpiry: string; longCalls: LongCallLeg[] },
): NakedBanResult {
  const shorts = Math.abs(shortCallQty);
  const shareCover = Math.floor(Math.max(0, sharesOwned) / 100);
  if (shareCover >= shorts) return { passed: true, gateName: "Naked Ban", coveredBy: "shares" };

  let needed = shorts - shareCover;
  const locked: number[] = [];
  if (pmcc) {
    pmcc.longCalls
      .map((leg, idx) => ({ leg, idx }))
      .filter(({ leg }) => longCallCovers(leg, pmcc.shortStrike, pmcc.shortExpiry))
      .sort((a, b) => b.leg.expiry.localeCompare(a.leg.expiry)) // lock the longest-dated first
      .forEach(({ leg, idx }) => {
        if (needed <= 0) return;
        locked.push(idx);
        needed -= leg.contracts;
      });
  }
  if (needed <= 0) {
    return {
      passed: true,
      gateName: "Naked Ban",
      coveredBy: shareCover > 0 ? "shares+long-call" : "long-call",
      lockedLongCallIdx: locked,
    };
  }
  const why = pmcc
    ? `no qualifying long call (needs strike <= ${currency(pmcc.shortStrike)} and expiry after ${pmcc.shortExpiry})`
    : `have ${sharesOwned} shares`;
  return {
    passed: false,
    gateName: "Naked Ban",
    reason: `${shorts} short call${shorts === 1 ? "" : "s"} not covered: need ${shorts * 100} shares or qualifying long calls; ${why}`,
  };
}

/** Instrument Ban: no leveraged or inverse ETFs of any multiplier. */
export function checkInstrumentBanGate(ticker: string, rules: WheelRules = loadWheelRules()): GateResult {
  const t = ticker.trim().toUpperCase();
  if (rules.instrumentBan.tickers.includes(t)) {
    return { passed: false, gateName: "Instrument Ban", reason: `${t} is a leveraged/inverse ETF - banned` };
  }
  return { passed: true, gateName: "Instrument Ban" };
}

/** CSP delta advisory (v2.1): non-blocking note when |delta| is outside the 0.15-0.30 band. */
export function cspDeltaAdvisory(delta: number | null | undefined, rules: WheelRules = loadWheelRules()): GateResult | null {
  if (delta === null || delta === undefined) return null;
  const { min, max } = rules.csp.deltaAdvisory;
  const m = Math.abs(delta);
  if (m < min - 1e-9 || m > max + 1e-9) {
    return {
      passed: true,
      advisory: true,
      gateName: "CSP Delta Band",
      reason: `Delta ${m.toFixed(2)} outside ${min.toFixed(2)}-${max.toFixed(2)} target band`,
    };
  }
  return null;
}

export function checkConcentrationGate(input: ChecklistInput, rules: WheelRules = loadWheelRules()): GateResult | null {
  const accountValue = input.accountValue ?? 0;
  if (accountValue <= 0) return null;
  const currentTickerValue = input.currentTickerValue ?? 0;
  const newCapital = input.newCapital ?? 0;
  const newPct = ((currentTickerValue + newCapital) / accountValue) * 100;
  const cap = rules.gate0.singleNameCapPct;
  if (newPct > cap) {
    return {
      passed: false,
      gateName: "Concentration",
      reason: `${input.ticker.toUpperCase()} would be ${newPct.toFixed(1)}% of portfolio (${cap}% limit)`,
    };
  }
  return { passed: true, gateName: "Concentration" };
}

// 15% Max-Collateral Cap — a single new CSP's reserved collateral cannot exceed 15% of account value.
export function checkMaxCollateralGate(input: ChecklistInput, rules: WheelRules = loadWheelRules()): GateResult | null {
  const accountValue = input.accountValue ?? 0;
  const newCapital = input.newCapital ?? 0;
  if (accountValue <= 0 || newCapital <= 0) return null;
  const pct = (newCapital / accountValue) * 100;
  const cap = rules.maxCollateral.capPct;
  if (pct > cap) {
    return {
      passed: false,
      gateName: "Max-Collateral Cap",
      reason: `${input.ticker.toUpperCase()} CSP would reserve ${pct.toFixed(1)}% of account (${cap}% cap)`,
    };
  }
  return { passed: true, gateName: "Max-Collateral Cap" };
}

// 0.30 Delta entry filter (project mandate, "the 0.30 Delta/RSI < 35 entry filter,
// enforced without exception"). A CSP struck too close to the money has too high an
// assignment probability for the wheel's intended pullback-entry profile - this caps it.
// Missing delta (IV unavailable from Yahoo) doesn't block, it just isn't cross-checked -
// same policy already used for the earnings gate when a date can't be found.
export function checkDeltaGate(delta: number | null | undefined, rules: WheelRules = loadWheelRules()): GateResult {
  if (delta === null || delta === undefined) return { passed: true, gateName: "0.30 Delta Filter" };
  const magnitude = Math.abs(delta);
  const max = rules.csp.maxEntryDelta;
  if (magnitude > max + 1e-9) {
    return {
      passed: false,
      gateName: "0.30 Delta Filter",
      reason: `Delta ${magnitude.toFixed(2)} exceeds the ${max.toFixed(2)} entry filter (too close to the money)`,
    };
  }
  return { passed: true, gateName: "0.30 Delta Filter" };
}

export function runPreTradeChecklist(input: ChecklistInput, rules: WheelRules = loadWheelRules()): GateResult[] {
  const results: GateResult[] = [];
  const concentration = checkConcentrationGate(input, rules);
  if (concentration) results.push(concentration);
  const collateral = checkMaxCollateralGate(input, rules);
  if (collateral) results.push(collateral);
  results.push(checkMaxPainGate(input.strike, input.kind, input.maxPain));
  results.push(checkRule6Gate(input.kind, input.marketDirection));
  results.push(checkEarningsGate(input.daysToEarnings, rules));
  if (input.kind === "put") {
    results.push(checkDeltaGate(input.delta, rules));
    const advisory = cspDeltaAdvisory(input.delta, rules);
    if (advisory) results.push(advisory);
  }
  if (input.kind === "call") {
    results.push(checkCapitalDefenseGate(input.strike, input.lot ?? input.costBasis));
    if ((input.shortCallQty ?? 0) < 0) {
      results.push(
        checkNakedBanGate(
          input.shortCallQty,
          input.sharesOwned,
          input.longCalls?.length && input.shortCallExpiry
            ? { shortStrike: input.strike, shortExpiry: input.shortCallExpiry, longCalls: input.longCalls }
            : undefined,
        ),
      );
    }
  }
  results.push(checkInstrumentBanGate(input.ticker, rules));
  return results;
}

export function verdictFor(results: GateResult[]) {
  return results.every((result) => result.passed) ? "APPROVED" : "BLOCKED";
}

export function advisoriesFrom(results: GateResult[]): string[] {
  return results.filter((r) => r.advisory && r.reason).map((r) => r.reason as string);
}
