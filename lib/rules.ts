// Typed loader for config/wheel-rules.yaml (Wheel Rules v2.1).
// Server-side only (reads the file with fs). Client components should receive the
// values they need as props from a server route, never import this module.

import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";

export type Range = { min: number; max: number };

export type WheelRules = {
  version: string;
  gate0: { singleNameCapPct: number };
  gate02: { factorCapPct: number | null };
  maxCollateral: { capPct: number };
  earnings: { blackoutDays: number };
  exDividend: { windowDays: number };
  instrumentBan: { tickers: string[] };
  csp: {
    maxEntryDelta: number;
    deltaAdvisory: Range;
    profitTarget: { brokerage: number; ira: number };
    timeStopDte: number;
  };
  pmcc: {
    leaps: {
      entryMinDelta: number;
      entryMinDte: number;
      stopWritingDelta: number;
      rollOutDte: number;
      reviewDrawdownPct: number;
    };
    short: { deltaAdvisory: Range; dteAdvisory: Range; profitTarget: number; timeStopDte: number };
    harvest: { spreadWidthPct: number; minShortExtrinsic: number };
    rolls: { max: number; requireNetCredit: boolean };
  };
};

export const RULES_PATH = path.join(process.cwd(), "config", "wheel-rules.yaml");

function num(obj: unknown, pathStr: string): number {
  const value = pathStr.split(".").reduce<unknown>((cur, k) => (cur && typeof cur === "object" ? (cur as Record<string, unknown>)[k] : undefined), obj);
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`wheel-rules.yaml: "${pathStr}" must be a number (got ${JSON.stringify(value)})`);
  }
  return value;
}

function numOrNull(obj: unknown, pathStr: string): number | null {
  const value = pathStr.split(".").reduce<unknown>((cur, k) => (cur && typeof cur === "object" ? (cur as Record<string, unknown>)[k] : undefined), obj);
  if (value === null || value === undefined) return null;
  return num(obj, pathStr);
}

function range(obj: unknown, pathStr: string): Range {
  const r = { min: num(obj, `${pathStr}.min`), max: num(obj, `${pathStr}.max`) };
  if (r.min > r.max) throw new Error(`wheel-rules.yaml: "${pathStr}" min > max`);
  return r;
}

/** Parse + validate YAML text into WheelRules. Throws with the offending key on bad config. */
export function parseWheelRules(text: string): WheelRules {
  const raw = parse(text) as Record<string, unknown>;
  if (!raw || typeof raw !== "object") throw new Error("wheel-rules.yaml: empty or invalid");
  const tickers = ((raw.instrumentBan as Record<string, unknown> | undefined)?.tickers ?? []) as unknown[];
  if (!Array.isArray(tickers) || tickers.some((t) => typeof t !== "string")) {
    throw new Error('wheel-rules.yaml: "instrumentBan.tickers" must be a list of strings');
  }
  const rolls = (raw.pmcc as Record<string, Record<string, unknown>> | undefined)?.rolls;

  return {
    version: String(raw.version ?? ""),
    gate0: { singleNameCapPct: num(raw, "gate0.singleNameCapPct") },
    gate02: { factorCapPct: numOrNull(raw, "gate02.factorCapPct") },
    maxCollateral: { capPct: num(raw, "maxCollateral.capPct") },
    earnings: { blackoutDays: num(raw, "earnings.blackoutDays") },
    exDividend: { windowDays: num(raw, "exDividend.windowDays") },
    instrumentBan: { tickers: (tickers as string[]).map((t) => t.trim().toUpperCase()) },
    csp: {
      maxEntryDelta: num(raw, "csp.maxEntryDelta"),
      deltaAdvisory: range(raw, "csp.deltaAdvisory"),
      profitTarget: { brokerage: num(raw, "csp.profitTarget.brokerage"), ira: num(raw, "csp.profitTarget.ira") },
      timeStopDte: num(raw, "csp.timeStopDte"),
    },
    pmcc: {
      leaps: {
        entryMinDelta: num(raw, "pmcc.leaps.entryMinDelta"),
        entryMinDte: num(raw, "pmcc.leaps.entryMinDte"),
        stopWritingDelta: num(raw, "pmcc.leaps.stopWritingDelta"),
        rollOutDte: num(raw, "pmcc.leaps.rollOutDte"),
        reviewDrawdownPct: num(raw, "pmcc.leaps.reviewDrawdownPct"),
      },
      short: {
        deltaAdvisory: range(raw, "pmcc.short.deltaAdvisory"),
        dteAdvisory: range(raw, "pmcc.short.dteAdvisory"),
        profitTarget: num(raw, "pmcc.short.profitTarget"),
        timeStopDte: num(raw, "pmcc.short.timeStopDte"),
      },
      harvest: {
        spreadWidthPct: num(raw, "pmcc.harvest.spreadWidthPct"),
        minShortExtrinsic: num(raw, "pmcc.harvest.minShortExtrinsic"),
      },
      rolls: { max: num(raw, "pmcc.rolls.max"), requireNetCredit: rolls?.requireNetCredit !== false },
    },
  };
}

let cached: WheelRules | null = null;

/** Load config/wheel-rules.yaml once per process. */
export function loadWheelRules(): WheelRules {
  if (!cached) cached = parseWheelRules(readFileSync(RULES_PATH, "utf8"));
  return cached;
}
