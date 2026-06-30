import { getQuoteSnapshot } from "@/lib/integrations/yfinance";
import { NextResponse, type NextRequest } from "next/server";

export async function GET(request: NextRequest) {
  try {
    const ticker = new URL(request.url).searchParams.get("ticker") ?? "";
    if (!ticker.trim()) {
      return NextResponse.json({ error: "ticker is required" }, { status: 400 });
    }
    return NextResponse.json(await getQuoteSnapshot(ticker));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
