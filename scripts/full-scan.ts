// Full-watchlist live scan — batched + throttled so ~195 tickers don't fire a huge wall
// of simultaneous requests at Yahoo's undocumented endpoints and risk a rate-limit/IP
// block. runScreener() itself still runs each BATCH in parallel (Promise.all internally),
// this script just chunks the universe into small batches with a pause between them.
//
// Ticker universe: "Wheel Watchlist Tiers - Living Doc (v7)" FULL UNIVERSE list
// (Ryan Brain, updated 2026-08-24). MU and SLV are excluded on purpose — both are
// DO-NOT-ADD per the doc (existing concentration violations being rotated OUT via
// covered calls, not candidates for new CSPs). Leveraged/inverse single-stock ETFs
// (NVDL, TSLL, etc.) are banned instruments and were never in the universe list.
import { runScreener, type CspCandidateRow } from "../lib/screener";
import { FULL_UNIVERSE, DO_NOT_ADD as EXCLUDED } from "../lib/watchlist";
import { writeFileSync } from "node:fs";

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const BATCH_SIZE = 8;
  const BATCH_DELAY_MS = 2500;
  const accountValue = process.argv[2] ? Number(process.argv[2]) : 200000;

  const batches = chunk(FULL_UNIVERSE, BATCH_SIZE);
  console.log(`Scanning ${FULL_UNIVERSE.length} tickers (excluding DO-NOT-ADD: ${EXCLUDED.join(", ")}) in ${batches.length} batches of ${BATCH_SIZE}, ${BATCH_DELAY_MS}ms between batches.`);
  console.log(`Account value for gate math: $${accountValue.toLocaleString()}`);
  console.log("This will take several minutes. Do not close the terminal.\n");

  const allResults: CspCandidateRow[] = [];
  let errors = 0;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    process.stdout.write(`Batch ${i + 1}/${batches.length} [${batch.join(", ")}] ... `);
    try {
      const result = await runScreener({
        tickers: batch,
        dteMin: 14,
        dteMax: 45,
        minRoiPct: 1,
        excludeEarningsWithinDays: 7,
        accountValue,
      });
      allResults.push(...result.results);
      const readyCount = result.results.filter((r) => r.status === "ready").length;
      const errCount = result.results.filter((r) => r.skipReason !== null).length;
      errors += errCount;
      console.log(`done (${readyCount} ready, ${errCount} errors)`);
    } catch (err) {
      console.log(`BATCH FAILED: ${err instanceof Error ? err.message : err}`);
      for (const t of batch) {
        allResults.push({
          ticker: t, status: "avoid", verdict: null, score: null, price: null, strike: null,
          expiry: null, dte: null, bid: null, credit: null, roiPct: null, annRoiPct: null,
          maxPain: null, rsi: null, divergence: "none", divergenceNote: null, daysToEarnings: null,
          delta: null, iv: null, blockReasons: [], skipReason: err instanceof Error ? err.message : "Batch failed",
        });
      }
      errors += batch.length;
    }
    if (i < batches.length - 1) await sleep(BATCH_DELAY_MS);
  }

  allResults.sort((a, b) => {
    const order = { ready: 0, watch: 1, avoid: 2 } as const;
    if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
    return (b.score ?? -Infinity) - (a.score ?? -Infinity);
  });

  const ready = allResults.filter((r) => r.status === "ready");
  const watch = allResults.filter((r) => r.status === "watch");
  const avoid = allResults.filter((r) => r.status === "avoid");

  console.log(`\n===== SCAN COMPLETE =====`);
  console.log(`Scanned: ${allResults.length} | Ready: ${ready.length} | Watch: ${watch.length} | Avoid: ${avoid.length} | Errors: ${errors}`);

  if (ready.length) {
    console.log(`\n--- READY (approved + meets min ROI) ---`);
    for (const r of ready) {
      console.log(`${r.ticker.padEnd(6)} strike=${r.strike} exp=${r.expiry} dte=${r.dte} bid=${r.bid} roi=${r.roiPct}% ann=${r.annRoiPct}% maxPain=${r.maxPain} rsi=${r.rsi} delta=${r.delta ?? "-"} iv=${r.iv ?? "-"}% div=${r.divergence} score=${r.score}`);
    }
  } else {
    console.log(`\n--- READY: none this scan ---`);
  }

  if (watch.length) {
    console.log(`\n--- WATCH (approved, below min ROI threshold) ---`);
    for (const r of watch) {
      console.log(`${r.ticker.padEnd(6)} strike=${r.strike} exp=${r.expiry} dte=${r.dte} bid=${r.bid} roi=${r.roiPct}% ann=${r.annRoiPct}% maxPain=${r.maxPain} rsi=${r.rsi} delta=${r.delta ?? "-"} iv=${r.iv ?? "-"}% div=${r.divergence} score=${r.score}`);
    }
  }

  const errored = allResults.filter((r) => r.skipReason !== null);
  if (errored.length) {
    console.log(`\n--- ERRORS/SKIPPED (${errored.length}) ---`);
    for (const r of errored) {
      console.log(`${r.ticker.padEnd(6)} ${r.skipReason}`);
    }
  }

  const outPath = `full-scan-results-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(outPath, JSON.stringify({ scannedAt: new Date().toISOString(), accountValue, excluded: EXCLUDED, results: allResults }, null, 2));
  console.log(`\nFull JSON written to ${outPath}`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
