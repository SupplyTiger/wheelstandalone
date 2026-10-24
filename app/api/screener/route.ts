import { NextResponse } from "next/server";
import { runScreener } from "../../../lib/screener";
import { parsePositionsParam, type AccountContext } from "../../../lib/positions";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function parseTickers(value: string | null): string[] {
  const tickers = (value ?? "")
    .split(",")
    .map((t) => t.trim().toUpperCase())
    .filter((t) => /^[A-Z][A-Z0-9.-]{0,9}$/.test(t));
  return Array.from(new Set(tickers)).slice(0, 40);
}

function numberParam(value: string | null, fallback: number) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// Optional money param: returns null when absent/invalid/negative, so a bad
// value degrades to "unknown" (gate skipped) instead of inventing a number.
function moneyOrNull(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const tickers = parseTickers(url.searchParams.get("tickers"));

  if (!tickers.length) {
    return NextResponse.json({ error: "No valid tickers provided" }, { status: 400 });
  }

  const dteMin = numberParam(url.searchParams.get("dteMin"), 7);
  const dteMax = numberParam(url.searchParams.get("dteMax"), 60);
  const minRoiPct = numberParam(url.searchParams.get("minRoi"), 1);
  const excludeEarningsWithinDays = numberParam(url.searchParams.get("excludeEarningsDays"), 14);
  const accountValue = numberParam(url.searchParams.get("accountValue"), 200000);

  // Per-account position context (from the Plaid feed — see lib/positions.ts
  // and docs/positions-feed.md). All four are optional; when none are given
  // the scan is exactly the historical position-blind call. A malformed
  // positions param is a 400, not a silent fallback: claiming
  // position-awareness on a broken book would be worse than none at all.
  let positions = null;
  try {
    positions = parsePositionsParam(url.searchParams.get("positions"));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid positions param";
    return NextResponse.json({ error: message }, { status: 400 });
  }
  const accountRaw = url.searchParams.get("account");
  const account = accountRaw && accountRaw.trim() !== "" ? accountRaw.trim().slice(0, 80) : null;
  const freeCash = moneyOrNull(url.searchParams.get("freeCash"));
  const reservedCollateral = moneyOrNull(url.searchParams.get("reserved"));
  const accountContext: AccountContext | null =
    account !== null || freeCash !== null || reservedCollateral !== null || (positions && positions.length > 0)
      ? { account, accountValue, freeCash, reservedCollateral, positions: positions ?? [] }
      : null;

  try {
    const scan = await runScreener({ tickers, dteMin, dteMax, minRoiPct, excludeEarningsWithinDays, accountValue, accountContext });
    return NextResponse.json(scan);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Screener failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
