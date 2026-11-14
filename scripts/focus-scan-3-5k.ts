// Focused CSP scan for 3-5k collateral chunks (strikes $30-$50).
// Scratch script — not part of the app build.
import { runScreener, type CspCandidateRow } from "../lib/screener";

const TICKERS = [
  "SOFI", "INTC", "F", "T", "PFE", "VZ", "BMY", "VTRS", "HIMS", "LYFT",
  "NKE", "SBUX", "CVS", "MRK", "MDT", "CHWY", "UBER", "HOOD", "DELL", "PYPL",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const all: CspCandidateRow[] = [];
  for (let i = 0; i < TICKERS.length; i += 10) {
    const batch = TICKERS.slice(i, i + 10);
    process.stdout.write(`batch [${batch.join(",")}] ... `);
    const r = await runScreener({
      tickers: batch,
      dteMin: 21,
      dteMax: 45,
      minRoiPct: 1,
      excludeEarningsWithinDays: 7,
      accountValue: 93000,
    });
    all.push(...r.results);
    console.log("done");
    if (i + 10 < TICKERS.length) await sleep(3000);
  }
  all.sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
  console.log("\n=== RESULTS (*** = $3k-$5k collateral) ===");
  for (const x of all) {
    const collat = x.strike ? x.strike * 100 : null;
    const mark = collat && collat >= 3000 && collat <= 5000 ? "***" : "   ";
    const blocks = (x.blockReasons || []).join(";");
    console.log(
      `${mark} ${x.ticker.padEnd(5)} ${x.status.padEnd(6)} px=${x.price} dchg=${x.dayChangePct}% ` +
      `K=${x.strike} exp=${x.expiry} dte=${x.dte} bid=${x.bid} roi=${x.roiPct}% ann=${x.annRoiPct}% ` +
      `delta=${x.delta} iv=${x.iv} rsi=${x.rsi} mp=${x.maxPain} earnIn=${x.daysToEarnings}d ` +
      `div=${x.divergence} score=${x.score}${x.skipReason ? " SKIP:" + x.skipReason : ""}${blocks ? " BLOCK:" + blocks : ""}`
    );
  }
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
