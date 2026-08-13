import { getSnapAccounts, getSnapBalances, getSnapOptionPositions, getSnapPositions, mapSnapOption, mapSnapPosition } from "@/lib/integrations/snaptrade";
import { env } from "@/lib/env";
import { writeLocalSnapshot } from "@/lib/local-snapshot";
import { getCurrentUser } from "@/lib/postgres/auth";
import { withTransaction } from "@/lib/postgres/client";
import { isMissingPostgresSchemaError } from "@/lib/postgres/errors";
import type { WheelPosition } from "@/lib/types";
import { NextResponse } from "next/server";

function numericFromBalances(balances: unknown, names: string[]) {
  const rows = Array.isArray(balances) ? balances : [balances];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    for (const name of names) {
      const nested = numericFromPath(row as Record<string, unknown>, name);
      if (nested !== null) return nested;
      const direct = (row as Record<string, unknown>)[name];
      if (typeof direct === "number") return direct;
      if (typeof direct === "string" && Number.isFinite(Number(direct))) return Number(direct);
    }
  }
  return null;
}

function numericFromPath(row: Record<string, unknown>, path: string) {
  if (!path.includes(".")) return null;
  const value = path.split(".").reduce<unknown>((current, part) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[part];
  }, row);
  if (typeof value === "number") return value;
  if (typeof value === "string" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function normalizeAccountNumber(value: string) {
  return value.replace(/\D/g, "");
}

function accountNumber(account: Record<string, unknown>) {
  return String(account.number ?? account.account_number ?? account.accountNumber ?? "");
}

function accountLabel(account: Record<string, unknown>) {
  const raw = accountNumber(account);
  const normalized = normalizeAccountNumber(raw);
  const last4 = normalized ? normalized.slice(-4) : "unknown";
  const name = String(account.name ?? account.institution_name ?? account.brokerage_name ?? account.type ?? "SnapTrade account");
  return `${name} ending ${last4}`;
}

function withLocalId(pos: WheelPosition, index: number): WheelPosition {
  return {
    id: `local-${index}-${pos.ticker}`,
    ...pos
  };
}

function isWheelPosition(position: WheelPosition | null): position is WheelPosition {
  return Boolean(position);
}

export async function POST() {
  try {
    const { user } = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const accounts = await getSnapAccounts();
    const configuredAccountNumbers = [
      env.SNAPTRADE_PRIMARY_ACCOUNT_NUMBER,
      env.SNAPTRADE_SECONDARY_ACCOUNT_NUMBER
    ]
      .filter(Boolean)
      .map((value) => normalizeAccountNumber(String(value)));
    const matchingAccounts = configuredAccountNumbers.length
      ? accounts.filter((account) => configuredAccountNumbers.includes(normalizeAccountNumber(accountNumber(account))))
      : [];
    const selectedAccounts = matchingAccounts.length ? matchingAccounts : accounts.slice(0, 1);

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
    const positions: WheelPosition[] = syncedAccounts.flatMap((payload) => [
      ...payload.stockPositions.map(mapSnapPosition).filter(isWheelPosition),
      ...payload.optionPositions.map(mapSnapOption)
    ]) as WheelPosition[];
    const cash = syncedAccounts.reduce((sum, payload) => {
      return sum + (numericFromBalances(payload.balances, ["cash", "cash_balance", "cashBalance"]) ?? 0);
    }, 0);
    const buyingPower = syncedAccounts.reduce((sum, payload) => {
      return sum + (numericFromBalances(payload.balances, ["buying_power", "buyingPower"]) ?? 0);
    }, 0);
    const reportedAccountValue = syncedAccounts.reduce((sum, payload, index) => {
      return (
        sum +
        (numericFromBalances(selectedAccounts[index], ["balance.total.amount", "total.amount", "total_value", "totalValue"]) ??
          numericFromBalances(payload.balances, ["total.amount", "total_value", "totalValue", "account_value"]) ??
          0)
      );
    }, 0);
    const netPositionValue = positions.reduce((sum, pos) => {
      const value = Number(pos.currentValue ?? 0);
      return sum + (pos.kind !== "stock" && pos.side === "short" ? -Math.abs(value) : value);
    }, 0);
    const accountValue = reportedAccountValue || cash + netPositionValue || positions.reduce((sum, pos) => sum + Math.abs(pos.currentValue ?? 0), 0);

    const syncedAt = new Date().toISOString();
    const accountSnapshot = {
      accountValue,
      floor: accountValue * 0.65,
      cash,
      buyingPower,
      cashSecuredPutCapacity: cash ?? buyingPower,
      source: "snaptrade",
      syncedAt
    };

    try {
      await withTransaction(async (client) => {
        await client.query(`delete from positions where user_id = $1`, [user.id]);

        for (const pos of positions) {
          await client.query(
            `insert into positions (
              user_id, ticker, symbol, kind, side, quantity, strike, expiry, price,
              avg_cost, current_value, gain_usd, gain_pct, option_mark_verified
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            [
              user.id,
              pos.ticker,
              pos.symbol ?? pos.ticker,
              pos.kind,
              pos.side ?? null,
              pos.quantity,
              pos.strike ?? null,
              pos.expiry ?? null,
              pos.price,
              pos.avgCost ?? null,
              pos.currentValue ?? null,
              pos.gainUsd ?? null,
              pos.gainPct ?? null,
              pos.optionMarkVerified ?? null
            ]
          );
        }

        await client.query(
          `insert into account_snapshots (
            user_id, account_value, floor, cash, buying_power,
            cash_secured_put_capacity, source, synced_at
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [user.id, accountValue, accountValue * 0.65, cash, buyingPower, cash ?? buyingPower, "snaptrade", syncedAt]
        );
      });
    } catch (databaseError) {
      if (!isMissingPostgresSchemaError(databaseError)) throw databaseError;
      await writeLocalSnapshot({
        account: accountSnapshot,
        positions: positions.map(withLocalId),
        warning: "Postgres schema is missing; using a local snapshot until the migration is applied."
      });

      return NextResponse.json({
        accountValue,
        cash,
        buyingPower,
        accountCount: syncedAccounts.length,
        positionCount: positions.length,
        storage: "local",
        warning: "Postgres schema is missing, so this sync was saved locally.",
        accountSelection:
          configuredAccountNumbers.length && !matchingAccounts.length
            ? {
                warning: "Configured account number did not match SnapTrade; synced the first available account instead.",
                availableAccounts: accounts.map(accountLabel)
              }
            : null
      });
    }

    return NextResponse.json({
      accountValue,
      cash,
      buyingPower,
      accountCount: syncedAccounts.length,
      positionCount: positions.length,
      accountSelection:
        configuredAccountNumbers.length && !matchingAccounts.length
          ? {
              warning: "Configured account number did not match SnapTrade; synced the first available account instead.",
              availableAccounts: accounts.map(accountLabel)
            }
          : null
    });
  } catch (error) {
    if (error && typeof error === "object") {
      const details = error as Record<string, unknown>;
      return NextResponse.json(
        {
          error: String(details.message ?? details.error_description ?? details.details ?? "Unknown error"),
          code: details.code ?? null,
          hint: details.hint ?? null,
          details: details.details ?? null
        },
        { status: 500 }
      );
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
