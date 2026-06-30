import { calculateMaxPain, dteFromExpiry } from "@/lib/wheel/math";
import { getYfinanceSnapshot } from "@/lib/integrations/yfinance";
import { NextResponse, type NextRequest } from "next/server";

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const ticker = url.searchParams.get("ticker") ?? "";
    const expiry = url.searchParams.get("expiry");
    const dteMin = Number(url.searchParams.get("dteMin") ?? 7);
    const dteMax = Number(url.searchParams.get("dteMax") ?? 60);
    if (!ticker.trim()) {
      return NextResponse.json({ error: "ticker is required" }, { status: 400 });
    }

    const snapshot = await getYfinanceSnapshot(ticker, expiry, dteMin, dteMax);
    const symbol = snapshot.ticker;
    const quote = snapshot.quote;
    const options = snapshot.options;
    const maxPain = calculateMaxPain(options);

    return NextResponse.json({
      ticker: symbol,
      quote,
      expirations: snapshot.expirations.map((expiration) => ({
        ...expiration,
        dte: dteFromExpiry(expiration.date)
      })),
      selectedExpiry: snapshot.selectedExpiry,
      selectedExpiries: snapshot.selectedExpiries ?? [],
      maxPain,
      optionsError: null,
      options
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
