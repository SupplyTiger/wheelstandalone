// Per-account position context for the CSP screener.
//
// THE GAP THIS CLOSES: the screener used to take a single accountValue and knew
// nothing about what the account already holds. It could therefore APPROVE a CSP
// on an underlying the account is already short a put on, and it sized collateral
// against the headline account total while only a fraction of that cash is free.
// A position-blind screener is not actionable without manual reconciliation
// against the real book — so the caller now passes the book in.
//
// WHERE THE BOOK COMES FROM (and where it does NOT):
// - The book comes from Plaid, via scripts/refresh-positions-by-account.mjs,
//   which Muse runs from its own Plaid connection. The script writes
//   public/positions-by-account.json, which is GITIGNORED (see .gitignore):
//   this repo is public, so live account data is never committed here.
// - The caller passes one account's context as screener query params
//   (account, freeCash, reserved, positions). No tokens live in this app,
//   and Muse's Plaid connection tokens are never exported anywhere.
// - SnapTrade is NOT used anywhere in this app. An older read-only SnapTrade
//   integration exists only on the unmerged feature/portfolio-api branch;
//   it was never merged to production and is not revived here.
//   See docs/positions-feed.md for the full architecture decision.
//
// CASH-SECURED ONLY (Ryan's hard rule, Oct 9: never use margin). The free-cash
// gate below enforces it: a new CSP's full strike x 100 collateral must fit
// inside the account's reported free cash. Margin borrowing is never assumed.
//
// This module is pure (no network, no env): every function here is unit-tested
// in lib/__tests__/logic.test.ts.

import type { GateResult } from "./gates";
import { currency } from "./gates";

export type PositionKind = "put" | "call" | "stock";
export type PositionSide = "short" | "long";

export type AccountPosition = {
  ticker: string;
  kind: PositionKind;
  side: PositionSide;
  /** Contracts for options, shares for stock. Defaults to 1 when omitted. */
  quantity?: number;
  strike?: number | null;
  expiry?: string | null;
  /** Broker-reported market value of a stock holding, when known. */
  marketValue?: number | null;
};

export type AccountContext = {
  /** Human label for the account being screened (e.g. "Prime Printer"). */
  account?: string | null;
  /** Headline account total (used by the existing %-of-account gates). */
  accountValue: number;
  /** Plaid-reported available cash. Null = unknown, gate skipped (never assumed). */
  freeCash?: number | null;
  /** Collateral already reserved by existing short puts, when known. */
  reservedCollateral?: number | null;
  positions: AccountPosition[];
};

const TICKER_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;
const MAX_POSITIONS = 100;
const MAX_PARAM_CHARS = 8192;

/**
 * Parse the screener's `positions` query param: a JSON array of AccountPosition.
 * Returns null when the param is absent/blank (caller is position-blind, the
 * historical behavior). Throws on malformed input — silently ignoring a broken
 * book would let the screener claim position-awareness it does not have.
 */
export function parsePositionsParam(raw: string | null | undefined): AccountPosition[] | null {
  if (raw === null || raw === undefined || raw.trim() === "") return null;
  if (raw.length > MAX_PARAM_CHARS) {
    throw new Error(`positions param exceeds ${MAX_PARAM_CHARS} characters — pass fewer positions`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("positions param is not valid JSON — expected an array of {ticker, kind, side, ...}");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("positions param must be a JSON array of positions");
  }
  if (parsed.length > MAX_POSITIONS) {
    throw new Error(`positions param holds ${parsed.length} positions (max ${MAX_POSITIONS})`);
  }
  return parsed.map((p, i) => {
    if (typeof p !== "object" || p === null) {
      throw new Error(`positions[${i}] is not an object`);
    }
    const o = p as Record<string, unknown>;
    const ticker = typeof o.ticker === "string" ? o.ticker.trim().toUpperCase() : "";
    if (!TICKER_RE.test(ticker)) {
      throw new Error(`positions[${i}] has an invalid ticker: ${JSON.stringify(o.ticker)}`);
    }
    if (o.kind !== "put" && o.kind !== "call" && o.kind !== "stock") {
      throw new Error(`positions[${i}] (${ticker}) has an invalid kind: ${JSON.stringify(o.kind)}`);
    }
    if (o.side !== "short" && o.side !== "long") {
      throw new Error(`positions[${i}] (${ticker}) has an invalid side: ${JSON.stringify(o.side)}`);
    }
    const quantity = o.quantity === undefined || o.quantity === null ? 1 : Number(o.quantity);
    if (!Number.isFinite(quantity) || quantity < 0) {
      throw new Error(`positions[${i}] (${ticker}) has an invalid quantity: ${JSON.stringify(o.quantity)}`);
    }
    const strike = o.strike === undefined || o.strike === null ? null : Number(o.strike);
    if (strike !== null && (!Number.isFinite(strike) || strike < 0)) {
      throw new Error(`positions[${i}] (${ticker}) has an invalid strike: ${JSON.stringify(o.strike)}`);
    }
    const expiry = o.expiry === undefined || o.expiry === null ? null : String(o.expiry);
    const marketValue =
      o.marketValue === undefined || o.marketValue === null ? null : Number(o.marketValue);
    if (marketValue !== null && !Number.isFinite(marketValue)) {
      throw new Error(`positions[${i}] (${ticker}) has an invalid marketValue: ${JSON.stringify(o.marketValue)}`);
    }
    return { ticker, kind: o.kind, side: o.side, quantity, strike, expiry, marketValue };
  });
}

/** The short put the account already holds on this ticker, if any. */
export function findShortPut(positions: AccountPosition[], ticker: string): AccountPosition | null {
  const t = ticker.toUpperCase();
  return positions.find((p) => p.ticker === t && p.kind === "put" && p.side === "short") ?? null;
}

/** Collateral already reserved by all short puts in the book (strike x 100 x contracts). */
export function reservedPutCapital(positions: AccountPosition[]): number {
  return positions.reduce((sum, p) => {
    if (p.kind === "put" && p.side === "short" && p.strike) {
      return sum + p.strike * 100 * (p.quantity ?? 1);
    }
    return sum;
  }, 0);
}

/**
 * Existing exposure to one ticker, for the 30% concentration gate: stock market
 * value held plus capital reserved by short puts on it. (Short calls do not add
 * CSP-side exposure; shares held do count toward concentration.)
 */
export function tickerExposure(positions: AccountPosition[], ticker: string): number {
  const t = ticker.toUpperCase();
  return positions.reduce((sum, p) => {
    if (p.ticker !== t) return sum;
    if (p.kind === "stock" && p.side === "long") return sum + (p.marketValue ?? 0);
    if (p.kind === "put" && p.side === "short" && p.strike) {
      return sum + p.strike * 100 * (p.quantity ?? 1);
    }
    return sum;
  }, 0);
}

/**
 * Free-cash gate: a new CSP's full strike x 100 collateral must fit inside the
 * account's reported free cash. Null when freeCash is unknown (gate skipped —
 * an unknown cash figure must never silently pass or fail a trade).
 */
export function checkFreeCashGate(newCapital: number, freeCash: number | null | undefined): GateResult | null {
  if (freeCash === null || freeCash === undefined || Number.isNaN(freeCash)) return null;
  if (newCapital > freeCash) {
    return {
      passed: false,
      gateName: "Free Cash",
      reason: `CSP needs ${currency(newCapital)} collateral but free cash is ${currency(freeCash)} — cash-secured only, no margin`,
    };
  }
  return { passed: true, gateName: "Free Cash" };
}

/**
 * Why a same-ticker CSP is blocked when the account already holds a short put.
 * Wheel rule: one short put per underlying per account. Assignment risk stacks
 * if you double an underlying, and a second put on a name you are already short
 * is not diversification — it is concentration wearing a different expiry.
 */
export function duplicateShortPutReason(pos: AccountPosition): string {
  const contract =
    pos.strike && pos.expiry ? ` (${currency(pos.strike)} put, ${pos.expiry})` : "";
  return `Already short a ${pos.ticker} put in this account${contract} — one short put per underlying, no doubling`;
}
