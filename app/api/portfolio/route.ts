// GET /api/portfolio — read-only snapshot of the SnapTrade-linked Fidelity accounts.
//
// Returns accounts (last 4 of the account number only), balances, stock positions and
// option positions. No database, no writes, no brokerage actions.
//
// Access: if PORTFOLIO_API_TOKEN is set in the environment, callers must send it as
// `x-portfolio-token` header (or ?token=). If it is NOT set, the route is open to anyone
// who can reach the deployment — set it (or Vercel Deployment Protection) before this is
// relied on in production.

import { NextResponse } from "next/server";
import {
  SnapTradeConfigError,
  SnapTradeHttpError,
  getBalances,
  getOptionHoldings,
  getPositions,
  last4,
  listAccounts,
  mapBalances,
  mapOptionPosition,
  mapStockPosition,
  snapTradeEnvStatus,
} from "../../../lib/snaptrade";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Raw = Record<string, unknown>;

function authorized(request: Request): boolean {
  const expected = process.env.PORTFOLIO_API_TOKEN?.trim();
  if (!expected) return true;
  const url = new URL(request.url);
  const supplied = request.headers.get("x-portfolio-token") ?? url.searchParams.get("token");
  return supplied === expected;
}

async function settle<T>(label: string, fn: () => Promise<T>, errors: string[]): Promise<T | null> {
  try {
    return await fn();
  } catch (error) {
    errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export async function GET(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const fetchedAt = new Date().toISOString();

  let accounts: Raw[];
  try {
    accounts = (await listAccounts()) ?? [];
  } catch (error) {
    if (error instanceof SnapTradeConfigError) {
      return NextResponse.json(
        { ok: false, stage: "config", error: error.message, env: snapTradeEnvStatus(), fetchedAt },
        { status: 500 },
      );
    }
    if (error instanceof SnapTradeHttpError) {
      // 401/403 here almost always means a bad consumer key / user secret pair.
      return NextResponse.json(
        {
          ok: false,
          stage: "listAccounts",
          snaptradeStatus: error.status,
          error: error.detail || error.message,
          hint:
            error.status === 401 || error.status === 403
              ? "Credentials rejected — re-check SNAPTRADE_CONSUMER_KEY and SNAPTRADE_USER_SECRET in Vercel."
              : undefined,
          fetchedAt,
        },
        { status: 502 },
      );
    }
    return NextResponse.json(
      { ok: false, stage: "listAccounts", error: error instanceof Error ? error.message : "Unknown error", fetchedAt },
      { status: 502 },
    );
  }

  const errors: string[] = [];

  const results = await Promise.all(
    accounts.map(async (account) => {
      const id = String(account.id ?? "");
      const tag = `acct …${last4(account.number)}`;
      const [positions, options, balances] = await Promise.all([
        settle(`${tag} positions`, () => getPositions(id), errors),
        settle(`${tag} options`, () => getOptionHoldings(id), errors),
        settle(`${tag} balances`, () => getBalances(id), errors),
      ]);

      const stocks = (positions ?? []).map((p) => mapStockPosition(p));
      const total = (account.balance as Raw | undefined)?.total as Raw | undefined;
      const sync = account.sync_status as Raw | undefined;
      const holdingsSync = sync?.holdings as Raw | undefined;

      return {
        last4: last4(account.number),
        name: String(account.name ?? account.institution_name ?? "Account"),
        institution: account.institution_name ? String(account.institution_name) : null,
        totalValue: typeof total?.amount === "number" ? total.amount : null,
        lastHoldingsSync: holdingsSync?.last_successful_sync ? String(holdingsSync.last_successful_sync) : null,
        balances: balances ? mapBalances(balances) : [],
        stocks: stocks.filter((s) => !s.cashEquivalent),
        cashEquivalents: stocks.filter((s) => s.cashEquivalent),
        options: (options ?? []).map((o) => mapOptionPosition(o)),
      };
    }),
  );

  const totals = {
    accounts: results.length,
    totalValue: results.reduce((sum, a) => sum + (a.totalValue ?? 0), 0),
    stockPositions: results.reduce((n, a) => n + a.stocks.length, 0),
    optionPositions: results.reduce((n, a) => n + a.options.length, 0),
    shortPuts: results.reduce((n, a) => n + a.options.filter((o) => o.side === "short" && o.type === "put").length, 0),
    shortCalls: results.reduce((n, a) => n + a.options.filter((o) => o.side === "short" && o.type === "call").length, 0),
  };

  return NextResponse.json(
    { ok: errors.length === 0, partial: errors.length > 0, fetchedAt, totals, accounts: results, errors },
    { headers: { "Cache-Control": "no-store" } },
  );
}
