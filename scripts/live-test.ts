import { runScreener } from "../lib/screener";

async function main() {
  const tickers = process.argv[2] ? process.argv[2].split(",") : ["AAPL", "SOFI"];
  console.log(`Testing live screener for: ${tickers.join(", ")}`);
  const result = await runScreener({
    tickers,
    dteMin: 7,
    dteMax: 60,
    minRoiPct: 1,
    excludeEarningsWithinDays: 14,
    accountValue: 200000,
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
