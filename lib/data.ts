import type { AccountSnapshot, WheelPosition } from "@/lib/types";
import { getEffectiveUser } from "@/lib/dev-auth";
import { env } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";

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

export async function getDashboardData() {
  const supabase = createSupabaseServerClient();
  if (!supabase) {
    return {
      userEmail: null,
      account: fallbackAccount,
      positions: [] as WheelPosition[],
      watchlist: defaultWatchlist,
      isConfigured: false,
      missingSnapTradeEnv: [] as string[]
    };
  }

  const effective = await getEffectiveUser(supabase);
  const { user } = effective;

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

  const [accountResult, positionsResult, watchlistResult] = await Promise.all([
    effective.supabase
      .from("account_snapshots")
      .select("*")
      .eq("user_id", user.id)
      .order("synced_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    effective.supabase.from("positions").select("*").eq("user_id", user.id).order("ticker", { ascending: true }),
    effective.supabase.from("watchlist").select("ticker").eq("user_id", user.id).order("ticker", { ascending: true })
  ]);

  const accountRow = accountResult.data;
  const account: AccountSnapshot = accountRow
    ? {
        id: accountRow.id,
        accountValue: Number(accountRow.account_value ?? 0),
        floor: Number(accountRow.floor ?? 0),
        cash: accountRow.cash === null ? null : Number(accountRow.cash ?? 0),
        buyingPower: accountRow.buying_power === null ? null : Number(accountRow.buying_power ?? 0),
        cashSecuredPutCapacity:
          accountRow.cash_secured_put_capacity === null ? null : Number(accountRow.cash_secured_put_capacity ?? 0),
        source: accountRow.source,
        syncedAt: accountRow.synced_at
      }
    : fallbackAccount;

  const positions = (positionsResult.data ?? []).map((row): WheelPosition => {
    return {
      id: row.id,
      ticker: row.ticker,
      symbol: row.symbol ?? row.ticker,
      kind: row.kind,
      side: row.side,
      quantity: Number(row.quantity ?? 0),
      strike: row.strike === null ? null : Number(row.strike),
      expiry: row.expiry,
      price: Number(row.price ?? 0),
      avgCost: row.avg_cost === null ? null : Number(row.avg_cost),
      currentValue: row.current_value === null ? null : Number(row.current_value),
      gainUsd: row.gain_usd === null ? null : Number(row.gain_usd),
      gainPct: row.gain_pct === null ? null : Number(row.gain_pct),
      optionMarkVerified: row.option_mark_verified
    };
  });

  const watchlist = (watchlistResult.data ?? []).map((row) => row.ticker);
  const missingSnapTradeEnv = [
    "SNAPTRADE_CLIENT_ID",
    "SNAPTRADE_CONSUMER_KEY",
    "SNAPTRADE_USER_ID",
    "SNAPTRADE_USER_SECRET"
  ].filter((name) => !env[name as keyof typeof env]);

  return {
    userEmail: effective.isLocalDev ? `${user.email ?? "local dev"} (local dev)` : user.email ?? null,
    account,
    positions,
    watchlist: watchlist.length ? watchlist : defaultWatchlist,
    isConfigured: true,
    missingSnapTradeEnv
  };
}
