import { NextResponse } from "next/server";
import { runPmccScreener } from "../../../lib/pmcc";
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

  // PMCC windows: LEAPS 12–24 months out, short leg 30–45 DTE. The route does
  // two chain fetches per ticker (one per window), so keep universes modest —
  // ~10 tickers per call stays inside the 60s limit; chunk larger universes.
  const leapsDteMin = numberParam(url.searchParams.get("leapsDteMin"), 365);
  const leapsDteMax = numberParam(url.searchParams.get("leapsDteMax"), 730);
  const shortDteMin = numberParam(url.searchParams.get("shortDteMin"), 30);
  const shortDteMax = numberParam(url.searchParams.get("shortDteMax"), 45);
  const leapsDeltaMin = numberParam(url.searchParams.get("leapsDeltaMin"), 0.7);
  const leapsDeltaMax = numberParam(url.searchParams.get("leapsDeltaMax"), 0.9);
  const shortDeltaMin = numberParam(url.searchParams.get("shortDeltaMin"), 0.2);
  const shortDeltaMax = numberParam(url.searchParams.get("shortDeltaMax"), 0.3);
  const minPremiumSharePct = numberParam(url.searchParams.get("minPremiumShare"), 2);
  const maxSpreadPct = numberParam(url.searchParams.get("maxSpreadPct"), 30);
  const zThreshold = numberParam(url.searchParams.get("zThreshold"), 2);
  const accountValue = numberParam(url.searchParams.get("accountValue"), 200000);
  const longDebitPerShare = moneyOrNull(url.searchParams.get("longDebit"));

  // Same contract discipline as /api/screener: a malformed positions param is
  // a 400, never a silent fallback to position-blind. When a long call is
  // passed for a ticker, that ticker screens in "existing-long" mode against
  // the actual long; otherwise it screens fresh LEAPS + short pairs.
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
    const scan = await runPmccScreener({
      tickers, leapsDteMin, leapsDteMax, shortDteMin, shortDteMax,
      leapsDeltaMin, leapsDeltaMax, shortDeltaMin, shortDeltaMax, minPremiumSharePct,
      maxSpreadPct, accountValue, accountContext, longDebitPerShare, zThreshold,
    });
    return NextResponse.json(scan);
  } catch (error) {
    const message = error instanceof Error ? error.message : "PMCC screener failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
