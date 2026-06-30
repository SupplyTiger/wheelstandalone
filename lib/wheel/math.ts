import type { GateResult, OptionContract, WheelPosition } from "@/lib/types";

export function safeNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function fmtUsd(value: number | null | undefined, sign = false): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  const abs = Math.abs(value).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2
  });
  if (value > 0 && sign) return `+${abs}`;
  if (value < 0) return `-${abs}`;
  return abs;
}

export function fmtPct(value: number | null | undefined, sign = false): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  const prefix = sign && value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(2)}%`;
}

export function dteFromExpiry(expiry: string | null | undefined, now = new Date()): number {
  if (!expiry) return 0;
  const exp = new Date(expiry);
  if (Number.isNaN(exp.getTime())) return 0;
  const ms = exp.getTime() - new Date(now.toDateString()).getTime();
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

export function calculateMaxPain(options: OptionContract[]): number | null {
  const strikes = Array.from(new Set(options.map((option) => option.strike))).sort((a, b) => a - b);
  if (strikes.length === 0) return null;
  const totalOi = options.reduce((sum, option) => sum + option.openInterest, 0);
  if (totalOi === 0) return null;

  let bestStrike = strikes[Math.floor(strikes.length / 2)];
  let minPain = Number.POSITIVE_INFINITY;
  for (const strike of strikes) {
    const pain = options.reduce((sum, option) => {
      if (option.kind === "call" && option.strike > strike) {
        return sum + (option.strike - strike) * option.openInterest;
      }
      if (option.kind === "put" && option.strike < strike) {
        return sum + (strike - option.strike) * option.openInterest;
      }
      return sum;
    }, 0);
    if (pain < minPain) {
      minPain = pain;
      bestStrike = strike;
    }
  }
  return bestStrike;
}

export function runPreTradeGates(input: {
  ticker: string;
  kind: "put" | "call";
  strike: number;
  maxPain: number | null;
  marketDirection: "red" | "green" | "unknown";
  daysToEarnings?: number | null;
  costBasis?: number | null;
  shortCallQty?: number;
  sharesOwned?: number;
  newCapital?: number;
  positions?: WheelPosition[];
  accountValue?: number;
}): GateResult[] {
  const results: GateResult[] = [];
  const positions = input.positions ?? [];
  const accountValue = input.accountValue ?? 0;
  const newCapital = input.newCapital ?? input.strike * 100;

  if (accountValue > 0) {
    const currentValue = positions
      .filter((pos) => pos.ticker.toUpperCase() === input.ticker.toUpperCase())
      .reduce((sum, pos) => sum + Math.abs(pos.quantity) * pos.price, 0);
    const pct = ((currentValue + newCapital) / accountValue) * 100;
    results.push({
      passed: pct <= 30,
      gateName: "Concentration",
      reason: pct > 30 ? `${input.ticker} would be ${pct.toFixed(1)}% of portfolio` : undefined
    });
  }

  if (input.maxPain !== null) {
    const blocked =
      (input.kind === "put" && input.strike >= input.maxPain) ||
      (input.kind === "call" && input.strike <= input.maxPain);
    results.push({
      passed: !blocked,
      gateName: "Max Pain",
      reason: blocked ? `${input.kind.toUpperCase()} strike conflicts with max pain ${fmtUsd(input.maxPain)}` : undefined
    });
  }

  const directionBlocked =
    (input.kind === "put" && input.marketDirection !== "red") ||
    (input.kind === "call" && input.marketDirection !== "green");
  results.push({
    passed: !directionBlocked,
    gateName: "Rule 6",
    reason: directionBlocked ? "Sell puts on red days and calls on green days" : undefined
  });

  if (input.daysToEarnings !== null && input.daysToEarnings !== undefined) {
    results.push({
      passed: input.daysToEarnings > 7,
      gateName: "Earnings",
      reason: input.daysToEarnings <= 7 ? `Earnings in ${input.daysToEarnings} DTE` : undefined
    });
  }

  if (input.kind === "call" && input.costBasis !== null && input.costBasis !== undefined) {
    results.push({
      passed: input.strike >= input.costBasis,
      gateName: "Capital Defense",
      reason: input.strike < input.costBasis ? `Call strike below cost basis ${fmtUsd(input.costBasis)}` : undefined
    });
  }

  if (input.kind === "call" && (input.shortCallQty ?? 0) < 0) {
    const needed = Math.abs(input.shortCallQty ?? 0) * 100;
    const shares = input.sharesOwned ?? 0;
    results.push({
      passed: shares >= needed,
      gateName: "Naked Ban",
      reason: shares < needed ? `Need ${needed} shares, have ${shares}` : undefined
    });
  }

  return results;
}
