import { getSnapAccounts, getSnapBalances, getSnapOptionPositions, getSnapPositions, mapSnapOption, mapSnapPosition } from "@/lib/integrations/snaptrade";
import { getEffectiveUser } from "@/lib/dev-auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { NextResponse } from "next/server";

function numericFromBalances(balances: unknown, names: string[]) {
  const rows = Array.isArray(balances) ? balances : [balances];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    for (const name of names) {
      const direct = (row as Record<string, unknown>)[name];
      if (typeof direct === "number") return direct;
      if (typeof direct === "string" && Number.isFinite(Number(direct))) return Number(direct);
    }
  }
  return null;
}

function accountNumber(account: Record<string, unknown>) {
  return String(account.number ?? account.account_number ?? account.accountNumber ?? "");
}

export async function POST() {
  try {
    const supabase = createSupabaseServerClient();
    if (!supabase) {
      return NextResponse.json({ error: "Supabase is not configured" }, { status: 500 });
    }

    const effective = await getEffectiveUser(supabase);
    const { user } = effective;
    if (!user) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const accounts = await getSnapAccounts();
    const configuredAccountNumbers = [
      env.SNAPTRADE_PRIMARY_ACCOUNT_NUMBER,
      env.SNAPTRADE_SECONDARY_ACCOUNT_NUMBER
    ].filter(Boolean);
    const selectedAccounts = configuredAccountNumbers.length
      ? accounts.filter((account) => configuredAccountNumbers.includes(accountNumber(account)))
      : accounts.slice(0, 1);

    if (!selectedAccounts.length) {
      return NextResponse.json({ error: "No SnapTrade account found" }, { status: 404 });
    }

    const accountPayloads = await Promise.all(
      selectedAccounts.map(async (account) => {
        const accountId = String(account.id ?? account.accountId ?? "");
        if (!accountId) return null;
        const [stockPositions, optionPositions, balances] = await Promise.all([
          getSnapPositions(accountId),
          getSnapOptionPositions(accountId),
          getSnapBalances(accountId)
        ]);
        return { stockPositions, optionPositions, balances };
      })
    );

    const syncedAccounts = accountPayloads.filter((payload): payload is NonNullable<typeof payload> => Boolean(payload));
    const positions = syncedAccounts.flatMap((payload) => [
      ...payload.stockPositions.map(mapSnapPosition),
      ...payload.optionPositions.map(mapSnapOption)
    ]);
    const accountValue = syncedAccounts.reduce((sum, payload) => {
      return (
        sum +
        (numericFromBalances(payload.balances, ["total_value", "totalValue", "account_value", "balance", "cash"]) ??
          0)
      );
    }, 0) || positions.reduce((sum, pos) => sum + Math.abs(pos.currentValue ?? 0), 0);
    const cash = syncedAccounts.reduce((sum, payload) => {
      return sum + (numericFromBalances(payload.balances, ["cash", "cash_balance", "cashBalance"]) ?? 0);
    }, 0);
    const buyingPower = syncedAccounts.reduce((sum, payload) => {
      return sum + (numericFromBalances(payload.balances, ["buying_power", "buyingPower"]) ?? 0);
    }, 0);

    await effective.supabase.from("positions").delete().eq("user_id", user.id);
    if (positions.length) {
      await effective.supabase.from("positions").insert(
        positions.map((pos) => ({
          user_id: user.id,
          ticker: pos.ticker,
          symbol: pos.symbol,
          kind: pos.kind,
          side: pos.side,
          quantity: pos.quantity,
          strike: "strike" in pos ? pos.strike : null,
          expiry: "expiry" in pos ? pos.expiry : null,
          price: pos.price,
          avg_cost: pos.avgCost,
          current_value: pos.currentValue,
          gain_usd: pos.gainUsd,
          gain_pct: pos.gainPct,
          option_mark_verified: "optionMarkVerified" in pos ? pos.optionMarkVerified : null
        }))
      );
    }

    await effective.supabase.from("account_snapshots").insert({
      user_id: user.id,
      account_value: accountValue,
      floor: accountValue * 0.65,
      cash,
      buying_power: buyingPower,
      cash_secured_put_capacity: cash ?? buyingPower,
      source: "snaptrade",
      synced_at: new Date().toISOString()
    });

    return NextResponse.json({
      accountValue,
      cash,
      buyingPower,
      accountCount: syncedAccounts.length,
      positionCount: positions.length
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
