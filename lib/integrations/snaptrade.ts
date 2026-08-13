import { Snaptrade } from "snaptrade-typescript-sdk";
import { requireEnv } from "@/lib/env";

function snapClient() {
  return new Snaptrade({
    clientId: requireEnv("SNAPTRADE_CLIENT_ID"),
    consumerKey: requireEnv("SNAPTRADE_CONSUMER_KEY")
  });
}

export function snapUserQs() {
  return {
    userId: requireEnv("SNAPTRADE_USER_ID"),
    userSecret: requireEnv("SNAPTRADE_USER_SECRET")
  };
}

export async function getSnapAccounts() {
  const user = snapUserQs();
  const response = await snapClient().accountInformation.listUserAccounts(user);
  return response.data as Array<Record<string, unknown>>;
}

export async function getSnapPositions(accountId: string) {
  const user = snapUserQs();
  const response = await snapClient().accountInformation.getUserAccountPositions({ ...user, accountId });
  return response.data as Array<Record<string, unknown>>;
}

export async function getSnapOptionPositions(accountId: string) {
  const user = snapUserQs();
  const response = await snapClient().options.listOptionHoldings({ ...user, accountId });
  return response.data as Array<Record<string, unknown>>;
}

export async function getSnapBalances(accountId: string) {
  const user = snapUserQs();
  const response = await snapClient().accountInformation.getUserAccountBalance({ ...user, accountId });
  return response.data as Record<string, unknown> | Array<Record<string, unknown>>;
}

export async function getSnapLoginLink() {
  const user = snapUserQs();
  const response = await snapClient().authentication.loginSnapTradeUser({
    ...user,
    broker: "FIDELITY",
    connectionType: "read",
    connectionPortalVersion: "v4"
  });
  return response.data as { redirectURI?: string };
}

function symbolText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
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
  const row = value as Record<string, unknown>;
  if (row[key] === true) return true;
  return Object.values(row).some((child) => booleanField(child, key));
}

export function mapSnapPosition(raw: Record<string, unknown>) {
  const instrument = ((raw.instrument as Record<string, unknown> | undefined) ??
    (typeof raw.symbol === "object" ? raw.symbol : undefined)) as Record<string, unknown> | undefined;

  const rawSymbol = symbolText(instrument) ?? symbolText(raw.symbol);
  const ticker = String(rawSymbol ?? "UNKNOWN").split(" ")[0].toUpperCase();
  const instrumentKind = String(instrument?.kind ?? raw.kind ?? "").toLowerCase();
  if (booleanField(instrument, "cash_equivalent") || ticker === "SPAXX" || (instrumentKind === "mutualfund" && ticker === "SPAXX")) {
    return null;
  }
  const units = Number(raw.units ?? raw.quantity ?? 0);
  const price = Number(raw.price ?? raw.last_price ?? 0);
  const averagePurchasePrice = Number(raw.average_purchase_price ?? raw.averagePurchasePrice ?? raw.cost_basis ?? 0);
  const marketValue = Number(raw.market_value ?? raw.marketValue ?? Math.abs(units) * price);
  const gainUsd =
    typeof raw.open_pnl === "number" ? raw.open_pnl : averagePurchasePrice ? (price - averagePurchasePrice) * units : null;

  return {
    ticker,
    symbol: String(rawSymbol ?? ticker),
    kind: "stock" as const,
    side: units < 0 ? ("short" as const) : ("long" as const),
    quantity: units,
    price,
    avgCost: averagePurchasePrice,
    currentValue: marketValue,
    gainUsd,
    gainPct: averagePurchasePrice ? ((price - averagePurchasePrice) / averagePurchasePrice) * 100 : null
  };
}

export function mapSnapOption(raw: Record<string, unknown>) {
  const symbol = (raw.symbol as Record<string, unknown> | undefined) ?? {};
  const optionSymbol = ((symbol.option_symbol as Record<string, unknown> | undefined) ??
    raw.option_symbol ??
    {}) as Record<string, unknown>;
  const underlying = (optionSymbol.underlying_symbol as Record<string, unknown> | undefined) ?? {};
  const ticker = String(underlying.raw_symbol ?? underlying.symbol ?? underlying.ticker ?? "UNKNOWN")
    .split(" ")[0]
    .toUpperCase();
  const quantity = Number(raw.units ?? 0);
  const contracts = Math.abs(quantity);
  const multiplier = optionSymbol.is_mini_option ? 10 : 100;
  const marketValue = Number(raw.market_value ?? raw.market_value_amount ?? raw.current_value ?? 0);
  const derivedMark = marketValue && contracts ? Math.abs(marketValue) / contracts / multiplier : Number(raw.price ?? 0);
  const averagePurchasePrice = Number(raw.average_purchase_price ?? 0) / multiplier;
  const kind = String(optionSymbol.option_type ?? "").toLowerCase() === "put" ? "put" : "call";

  return {
    ticker,
    symbol: `${ticker} ${optionSymbol.strike_price ?? "?"} ${kind.toUpperCase()} ${optionSymbol.expiration_date ?? ""}`.trim(),
    kind,
    side: quantity < 0 ? ("short" as const) : ("long" as const),
    quantity: contracts,
    strike: Number(optionSymbol.strike_price ?? 0) || null,
    expiry: optionSymbol.expiration_date ? String(optionSymbol.expiration_date).slice(0, 10) : null,
    price: derivedMark,
    avgCost: averagePurchasePrice,
    currentValue: derivedMark * contracts * multiplier,
    gainUsd: quantity < 0 ? (averagePurchasePrice - derivedMark) * contracts * multiplier : null,
    gainPct: averagePurchasePrice ? ((averagePurchasePrice - derivedMark) / averagePurchasePrice) * 100 : null,
    optionMarkVerified: Boolean(marketValue && contracts)
  };
}
