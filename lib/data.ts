import type { AccountSnapshot, WheelPosition } from "@/lib/types";
import { env } from "@/lib/env";
import { readLocalSnapshot } from "@/lib/local-snapshot";
import { getCurrentUser } from "@/lib/postgres/auth";
import { isPostgresConfigured, query } from "@/lib/postgres/client";
import { isMissingPostgresSchemaError } from "@/lib/postgres/errors";

const defaultWatchlist = ["AAPL", "AMD", "MSFT", "NVDA", "PLTR", "SLV"];

export const fallbackAccount: AccountSnapshot = {
  accountValue: 0,
  floor: 0,
  cash: 0,
  buyingPower: 0,
  cashSecuredPutCapacity: 0,
  source: "not connected",
  syncedAt: null
};

type AccountRow = {
  id: string;
  account_value: string | number | null;
  floor: string | number | null;
  cash: string | number | null;
  buying_power: string | number | null;
  cash_secured_put_capacity: string | number | null;
  source: string | null;
  synced_at: Date | string | null;
};

type PositionRow = {
  id: string;
  ticker: string;
  symbol: string | null;
  kind: WheelPosition["kind"];
  side: WheelPosition["side"] | null;
  quantity: string | number | null;
  strike: string | number | null;
  expiry: Date | string | null;
  price: string | number | null;
  avg_cost: string | number | null;
  current_value: string | number | null;
  gain_usd: string | number | null;
  gain_pct: string | number | null;
  option_mark_verified: boolean | null;
};

function numberOrNull(value: string | number | null | undefined) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoDateTime(value: Date | string | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function dateOnly(value: Date | string | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function missingSnapTradeEnv() {
  return [
    "SNAPTRADE_CLIENT_ID",
    "SNAPTRADE_CONSUMER_KEY",
    "SNAPTRADE_USER_ID",
    "SNAPTRADE_USER_SECRET"
  ].filter((name) => !env[name as keyof typeof env]);
}

function mapAccount(row: AccountRow | undefined): AccountSnapshot {
  if (!row) return fallbackAccount;
  return {
    id: row.id,
    accountValue: numberOrNull(row.account_value) ?? 0,
    floor: numberOrNull(row.floor) ?? 0,
    cash: numberOrNull(row.cash),
    buyingPower: numberOrNull(row.buying_power),
    cashSecuredPutCapacity: numberOrNull(row.cash_secured_put_capacity),
    source: row.source,
    syncedAt: isoDateTime(row.synced_at)
  };
}

function mapPosition(row: PositionRow): WheelPosition {
  return {
    id: row.id,
    ticker: row.ticker,
    symbol: row.symbol ?? row.ticker,
    kind: row.kind,
    side: row.side ?? undefined,
    quantity: numberOrNull(row.quantity) ?? 0,
    strike: numberOrNull(row.strike),
    expiry: dateOnly(row.expiry),
    price: numberOrNull(row.price) ?? 0,
    avgCost: numberOrNull(row.avg_cost),
    currentValue: numberOrNull(row.current_value),
    gainUsd: numberOrNull(row.gain_usd),
    gainPct: numberOrNull(row.gain_pct),
    optionMarkVerified: row.option_mark_verified
  };
}

export async function getDashboardData() {
  if (!isPostgresConfigured()) {
    return {
      userEmail: null,
      account: fallbackAccount,
      positions: [] as WheelPosition[],
      watchlist: defaultWatchlist,
      isConfigured: false,
      missingSnapTradeEnv: [] as string[]
    };
  }

  const session = await getCurrentUser();
  const { user } = session;

  if (!user) {
    return {
      userEmail: null,
      account: fallbackAccount,
      positions: [] as WheelPosition[],
      watchlist: defaultWatchlist,
      isConfigured: true,
      missingSnapTradeEnv: [] as string[]
    };
  }

  try {
    const [accountResult, positionsResult, watchlistResult] = await Promise.all([
      query<AccountRow>(
        `select id, account_value, floor, cash, buying_power, cash_secured_put_capacity, source, synced_at
         from account_snapshots
         where user_id = $1
         order by synced_at desc
         limit 1`,
        [user.id]
      ),
      query<PositionRow>(
        `select id, ticker, symbol, kind, side, quantity, strike, expiry, price, avg_cost,
                current_value, gain_usd, gain_pct, option_mark_verified
         from positions
         where user_id = $1
         order by ticker asc`,
        [user.id]
      ),
      query<{ ticker: string }>(
        `select ticker
         from watchlist
         where user_id = $1
         order by ticker asc`,
        [user.id]
      )
    ]);

    const watchlist = watchlistResult.rows.map((row) => row.ticker);

    return {
      userEmail: session.isLocalDev ? `${user.email} (local dev)` : user.email,
      account: mapAccount(accountResult.rows[0]),
      positions: positionsResult.rows.map(mapPosition),
      watchlist: watchlist.length ? watchlist : defaultWatchlist,
      isConfigured: true,
      missingSnapTradeEnv: missingSnapTradeEnv()
    };
  } catch (error) {
    if (!isMissingPostgresSchemaError(error)) throw error;
    const localSnapshot = await readLocalSnapshot();
    return {
      userEmail: session.isLocalDev ? `${user.email} (local dev)` : user.email,
      account: localSnapshot?.account ?? fallbackAccount,
      positions: localSnapshot?.positions ?? [],
      watchlist: defaultWatchlist,
      isConfigured: true,
      missingSnapTradeEnv: missingSnapTradeEnv()
    };
  }
}
