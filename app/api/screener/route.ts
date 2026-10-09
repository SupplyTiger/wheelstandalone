import { NextResponse } from "next/server";
import { runScreener } from "../../../lib/screener";

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

  try {
    const scan = await runScreener({ tickers, dteMin, dteMax, minRoiPct, excludeEarningsWithinDays, accountValue });
    return NextResponse.json(scan);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Screener failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
