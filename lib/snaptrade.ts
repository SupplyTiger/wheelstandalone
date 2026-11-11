// Read-only SnapTrade client for the Portfolio tab.
//
// No SDK dependency: requests are signed by hand the same way the SnapTrade SDK does it
// (HMAC-SHA256 over a sorted-key JSON of {content, path, query}, keyed by the consumer
// key, base64 in the `Signature` header). clientId/timestamp/userId/userSecret ride in the
// query string; the consumer key never leaves the server.
//
// Only GET endpoints are used here: list accounts, positions, option holdings, balances.
// Nothing in this file places, cancels, or modifies anything at the brokerage.
//
// Mapping helpers are ported from the legacy-full-app-pre-screener-rebuild branch
// (lib/integrations/snaptrade.ts), minus the Postgres/auth plumbing.

import { createHmac } from "node:crypto";

const SNAPTRADE_BASE = "https://api.snaptrade.com/api/v1";
const REQUEST_TIMEOUT_MS = 15_000;

const REQUIRED_ENV = [
  "SNAPTRADE_CLIENT_ID",
  "SNAPTRADE_CONSUMER_KEY",
  "SNAPTRADE_USER_ID",
  "SNAPTRADE_USER_SECRET",
] as const;

type RequiredKey = (typeof REQUIRED_ENV)[number];

export class SnapTradeConfigError extends Error {
  constructor(public missing: string[]) {
    super(`SnapTrade not configured: missing ${missing.join(", ")}`);
    this.name = "SnapTradeConfigError";
  }
}

export class SnapTradeHttpError extends Error {
  constructor(public status: number, public path: string, public detail: string) {
    super(`SnapTrade ${path} returned HTTP ${status}${detail ? `: ${detail}` : ""}`);
    this.name = "SnapTradeHttpError";
  }
}

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function config(): Record<RequiredKey, string> {
  const missing = REQUIRED_ENV.filter((k) => !readEnv(k));
  if (missing.length) throw new SnapTradeConfigError(missing);
  return Object.fromEntries(REQUIRED_ENV.map((k) => [k, readEnv(k)!])) as Record<RequiredKey, string>;
}

/** Key names only (never values) — used by the route's health output. */
export function snapTradeEnvStatus() {
  return Object.fromEntries(REQUIRED_ENV.map((k) => [k, Boolean(readEnv(k))])) as Record<RequiredKey, boolean>;
}

// Deterministic JSON with sorted keys and no whitespace — matches Python's
// json.dumps(obj, separators=(",", ":"), sort_keys=True) used by the SnapTrade SDKs.
function sortedJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${sortedJson(obj[k])}`)
    .join(",")}}`;
}

export function signSnapTrade(consumerKey: string, path: string, query: string, content: unknown = null) {
  const payload = sortedJson({ content: content ?? null, path: `/api/v1${path}`, query });
  return createHmac("sha256", consumerKey).update(payload).digest("base64");
}

async function snapGet<T>(path: string): Promise<T> {
  const cfg = config();
  const query = new URLSearchParams({
    clientId: cfg.SNAPTRADE_CLIENT_ID,
    timestamp: String(Math.floor(Date.now() / 1000)),
    userId: cfg.SNAPTRADE_USER_ID,
    userSecret: cfg.SNAPTRADE_USER_SECRET,
  }).toString();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${SNAPTRADE_BASE}${path}?${query}`, {
      method: "GET",
      headers: { Signature: signSnapTrade(cfg.SNAPTRADE_CONSUMER_KEY, path, query), Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      // SnapTrade error bodies look like {detail, status_code, code}; they don't echo credentials.
      let detail = text.slice(0, 300);
      try {
        const body = JSON.parse(text) as Record<string, unknown>;
        detail = [body.code, body.detail ?? body.message].filter(Boolean).join(" — ") || detail;
      } catch {
        /* keep raw snippet */
      }
      throw new SnapTradeHttpError(res.status, path, detail);
    }
    return (text ? JSON.parse(text) : null) as T;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new SnapTradeHttpError(504, path, `timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

type Raw = Record<string, unknown>;

export const listAccounts = () => snapGet<Raw[]>("/accounts");
export const getPositions = (accountId: string) => snapGet<Raw[]>(`/accounts/${encodeURIComponent(accountId)}/positions`);
export const getOptionHoldings = (accountId: string) => snapGet<Raw[]>(`/accounts/${encodeURIComponent(accountId)}/options`);
export const getBalances = (accountId: string) => snapGet<Raw[] | Raw>(`/accounts/${encodeURIComponent(accountId)}/balances`);

// ── Mapping ────────────────────────────────────────────────────────────────

export function last4(value: unknown): string {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits ? digits.slice(-4) : "????";
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function symbolText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  const row = value as Raw;
  for (const key of ["raw_symbol", "symbol", "ticker"]) {
    const direct = row[key];
    if (typeof direct === "string") return direct;
    const nested = symbolText(direct);
    if (nested) return nested;
  }
  return undefined;
}

function booleanField(value: unknown, key: string): boolean {
  if (!value || typeof value !== "object") return false;
  const row = value as Raw;
  if (row[key] === true) return true;
  return Object.values(row).some((child) => booleanField(child, key));
}

export type StockPosition = {
  ticker: string;
  side: "long" | "short";
  quantity: number;
  price: number | null;
  avgCost: number | null;
  marketValue: number | null;
  gainUsd: number | null;
  gainPct: number | null;
  cashEquivalent: boolean;
};

export function mapStockPosition(raw: Raw): StockPosition {
  const instrument = ((raw.instrument as Raw | undefined) ??
    (typeof raw.symbol === "object" ? raw.symbol : undefined)) as Raw | undefined;
  const rawSymbol = symbolText(instrument) ?? symbolText(raw.symbol);
  const ticker = String(rawSymbol ?? "UNKNOWN").split(" ")[0].toUpperCase();
  const units = num(raw.units ?? raw.quantity) ?? 0;
  const price = num(raw.price ?? raw.last_price);
  const avgCost = num(raw.average_purchase_price ?? raw.averagePurchasePrice ?? raw.cost_basis);
  const marketValue = num(raw.market_value ?? raw.marketValue) ?? (price !== null ? Math.abs(units) * price : null);
  const gainUsd =
    num(raw.open_pnl) ?? (price !== null && avgCost ? (price - avgCost) * units : null);
  const cashEquivalent = booleanField(instrument, "cash_equivalent") || ticker === "SPAXX";

  return {
    ticker,
    side: units < 0 ? "short" : "long",
    quantity: units,
    price,
    avgCost,
    marketValue,
    gainUsd,
    gainPct: price !== null && avgCost ? ((price - avgCost) / avgCost) * 100 : null,
    cashEquivalent,
  };
}

export type OptionPosition = {
  ticker: string;
  description: string;
  type: "put" | "call";
  side: "long" | "short";
  contracts: number;
  strike: number | null;
  expiry: string | null;
  dte: number | null;
  mark: number | null;
  avgPremium: number | null;
  marketValue: number | null;
  gainUsd: number | null;
  gainPct: number | null;
  markVerified: boolean;
};

export function mapOptionPosition(raw: Raw, now = new Date()): OptionPosition {
  const symbol = (raw.symbol as Raw | undefined) ?? {};
  const optionSymbol = ((symbol.option_symbol as Raw | undefined) ?? (raw.option_symbol as Raw | undefined) ?? {}) as Raw;
  const underlying = (optionSymbol.underlying_symbol as Raw | undefined) ?? {};
  const ticker = String(underlying.raw_symbol ?? underlying.symbol ?? underlying.ticker ?? "UNKNOWN")
    .split(" ")[0]
    .toUpperCase();
  const units = num(raw.units) ?? 0;
  const contracts = Math.abs(units);
  const multiplier = optionSymbol.is_mini_option ? 10 : 100;
  const reportedValue = num(raw.market_value ?? raw.market_value_amount ?? raw.current_value);
  const mark =
    reportedValue && contracts ? Math.abs(reportedValue) / contracts / multiplier : num(raw.price);
  const avgRaw = num(raw.average_purchase_price);
  const avgPremium = avgRaw !== null ? avgRaw / multiplier : null;
  const type = String(optionSymbol.option_type ?? "").toLowerCase() === "put" ? "put" : "call";
  const strike = num(optionSymbol.strike_price);
  const expiry = optionSymbol.expiration_date ? String(optionSymbol.expiration_date).slice(0, 10) : null;
  const dte = expiry
    ? Math.ceil((Date.parse(`${expiry}T20:00:00Z`) - now.getTime()) / 86_400_000)
    : null;
  const side = units < 0 ? "short" : "long";
  const gainUsd =
    mark !== null && avgPremium !== null
      ? (side === "short" ? avgPremium - mark : mark - avgPremium) * contracts * multiplier
      : null;

  return {
    ticker,
    description: `${ticker} ${strike ?? "?"} ${type.toUpperCase()} ${expiry ?? ""}`.trim(),
    type,
    side,
    contracts,
    strike,
    expiry,
    dte,
    mark,
    avgPremium,
    marketValue: mark !== null ? mark * contracts * multiplier * (side === "short" ? -1 : 1) : null,
    gainUsd,
    gainPct:
      mark !== null && avgPremium
        ? ((side === "short" ? avgPremium - mark : mark - avgPremium) / avgPremium) * 100
        : null,
    markVerified: Boolean(reportedValue && contracts),
  };
}

export type BalanceSummary = { currency: string; cash: number | null; buyingPower: number | null };

export function mapBalances(raw: Raw[] | Raw | null): BalanceSummary[] {
  const rows = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return rows.map((row) => {
    const currency = row.currency as Raw | string | undefined;
    return {
      currency: typeof currency === "string" ? currency : String(currency?.code ?? "USD"),
      cash: num(row.cash),
      buyingPower: num(row.buying_power),
    };
  });
}
