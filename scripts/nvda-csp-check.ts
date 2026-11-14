// One-off focused CSP check for NVDA, Thu Nov 12 2026 ~12:45 ET.
// Same screener + params as the morning full scan (delta cap 0.30, 14-45 DTE,
// 7-day earnings blackout, min ROI 1%). Account value passed is the SnapTrade
// backup Prime total; Gate 1 math is done on the verified Oct 30 base separately.
import { runScreener } from "../lib/screener";

async function main() {
  const accountValue = process.argv[2] ? Number(process.argv[2]) : 84202.57;
  const result = await runScreener({
    tickers: ["NVDA"],
    dteMin: 14,
    dteMax: 45,
    minRoiPct: 1,
    excludeEarningsWithinDays: 7,
    accountValue,
  });
  console.log(JSON.stringify(result, null, 2));
}
main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
