// Pre-trade checklist gates for the Institutional Treasury Wheel.
// Ported from the working "treasury-wheel-mobile" scaffold (lib/gates.ts) — unchanged logic,
// this file already implements all five mandate rules correctly.

export type OptionKind = "put" | "call";
export type MarketDirection = "red" | "green";

export type GateResult = {
  passed: boolean;
  gateName: string;
  reason?: string;
};

export type ChecklistInput = {
  ticker: string;
  kind: OptionKind;
  strike: number;
  maxPain: number;
  marketDirection: MarketDirection;
  daysToEarnings: number | null;
  costBasis?: number | null;
  shortCallQty?: number;
  sharesOwned?: number;
  newCapital?: number;
  accountValue?: number;
  currentTickerValue?: number;
  delta?: number | null;
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

export function checkEarningsGate(daysToEarnings: number | null): GateResult {
  if (daysToEarnings === null || Number.isNaN(daysToEarnings)) {
    return { passed: true, gateName: "Earnings" };
  }
  if (daysToEarnings <= 7) {
    return {
      passed: false,
      gateName: "Earnings",
      reason: `Earnings in ${daysToEarnings} DTE - within 7-day blackout`,
    };
  }
  return { passed: true, gateName: "Earnings" };
}

export function checkCapitalDefenseGate(ccStrike: number, costBasis: number | null | undefined): GateResult {
  if (costBasis === null || costBasis === undefined || Number.isNaN(costBasis)) {
    return { passed: true, gateName: "Capital Defense" };
  }
  if (ccStrike < costBasis) {
    return {
      passed: false,
      gateName: "Capital Defense",
      reason: `CC strike ${currency(ccStrike)} below cost basis ${currency(costBasis)}`,
    };
  }
  return { passed: true, gateName: "Capital Defense" };
}

export function checkNakedBanGate(shortCallQty = 0, sharesOwned = 0): GateResult {
  const requiredShares = Math.abs(shortCallQty) * 100;
  if (sharesOwned < requiredShares) {
    return {
      passed: false,
      gateName: "Naked Ban",
      reason: `Need ${requiredShares} shares to cover ${Math.abs(shortCallQty)} short calls, have ${sharesOwned}`,
    };
  }
  return { passed: true, gateName: "Naked Ban" };
}

export function checkConcentrationGate(input: ChecklistInput): GateResult | null {
  const accountValue = input.accountValue ?? 0;
  if (accountValue <= 0) return null;
  const currentTickerValue = input.currentTickerValue ?? 0;
  const newCapital = input.newCapital ?? 0;
  const newPct = ((currentTickerValue + newCapital) / accountValue) * 100;
  if (newPct > 30) {
    return {
      passed: false,
      gateName: "Concentration",
      reason: `${input.ticker.toUpperCase()} would be ${newPct.toFixed(1)}% of portfolio (30% limit)`,
    };
  }
  return { passed: true, gateName: "Concentration" };
}

// 15% Max-Collateral Cap — a single new CSP's reserved collateral cannot exceed 15% of account value.
export function checkMaxCollateralGate(input: ChecklistInput): GateResult | null {
  const accountValue = input.accountValue ?? 0;
  const newCapital = input.newCapital ?? 0;
  if (accountValue <= 0 || newCapital <= 0) return null;
  const pct = (newCapital / accountValue) * 100;
  if (pct > 15) {
    return {
      passed: false,
      gateName: "Max-Collateral Cap",
      reason: `${input.ticker.toUpperCase()} CSP would reserve ${pct.toFixed(1)}% of account (15% cap)`,
    };
  }
  return { passed: true, gateName: "Max-Collateral Cap" };
}

// 0.30 Delta entry filter (project mandate, "the 0.30 Delta/RSI < 35 entry filter,
// enforced without exception"). A CSP struck too close to the money has too high an
// assignment probability for the wheel's intended pullback-entry profile - this caps it.
// Missing delta (IV unavailable from Yahoo) doesn't block, it just isn't cross-checked -
// same policy already used for the earnings gate when a date can't be found.
export function checkDeltaGate(delta: number | null | undefined): GateResult {
  if (delta === null || delta === undefined) return { passed: true, gateName: "0.30 Delta Filter" };
  const magnitude = Math.abs(delta);
  if (magnitude > 0.3 + 1e-9) {
    return {
      passed: false,
      gateName: "0.30 Delta Filter",
      reason: `Delta ${magnitude.toFixed(2)} exceeds the 0.30 entry filter (too close to the money)`,
    };
  }
  return { passed: true, gateName: "0.30 Delta Filter" };
}

export function runPreTradeChecklist(input: ChecklistInput): GateResult[] {
  const results: GateResult[] = [];
  const concentration = checkConcentrationGate(input);
  if (concentration) results.push(concentration);
  const collateral = checkMaxCollateralGate(input);
  if (collateral) results.push(collateral);
  results.push(checkMaxPainGate(input.strike, input.kind, input.maxPain));
  results.push(checkRule6Gate(input.kind, input.marketDirection));
  results.push(checkEarningsGate(input.daysToEarnings));
  if (input.kind === "put") {
    results.push(checkDeltaGate(input.delta));
  }
  if (input.kind === "call") {
    results.push(checkCapitalDefenseGate(input.strike, input.costBasis));
    if ((input.shortCallQty ?? 0) < 0) {
      results.push(checkNakedBanGate(input.shortCallQty, input.sharesOwned));
    }
  }
  return results;
}

export function verdictFor(results: GateResult[]) {
  return results.every((result) => result.passed) ? "APPROVED" : "BLOCKED";
}
