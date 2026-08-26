"use client";

import { useState } from "react";
import { CORE_WATCHLIST, FULL_UNIVERSE } from "../lib/watchlist";

type CandidateStatus = "ready" | "watch" | "avoid";

type CspCandidateRow = {
  ticker: string;
  status: CandidateStatus;
  verdict: "APPROVED" | "BLOCKED" | null;
  score: number | null;
  price: number | null;
  strike: number | null;
  expiry: string | null;
  dte: number | null;
  bid: number | null;
  roiPct: number | null;
  annRoiPct: number | null;
  maxPain: number | null;
  rsi: number | null;
  divergence: "bullish" | "bearish" | "none";
  divergenceNote: string | null;
  daysToEarnings: number | null;
  delta: number | null;
  blockReasons: string[];
  skipReason: string | null;
};

type ScanSummary = { scanned: number; ready: number; watch: number; avoid: number; errors: number };

type ScanResponse = {
  scannedAt: string;
  results: CspCandidateRow[];
  summary: ScanSummary;
};

// Your Tier 1-3 core watchlist (v7 doc), DO-NOT-ADD names already excluded. This is the
// default in the box below — small enough that "Run Screener" finishes in one request.
const DEFAULT_WATCHLIST = CORE_WATCHLIST.join(", ");

// Same 8-per-batch / throttled pattern as scripts/full-scan.ts, just driven from the
// browser instead of a terminal, so "Scan Full Watchlist" doesn't time out a single
// serverless request or fire 194 tickers at Yahoo all at once.
const FULL_SCAN_BATCH_SIZE = 8;
const FULL_SCAN_BATCH_DELAY_MS = 2500;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sortResults(rows: CspCandidateRow[]): CspCandidateRow[] {
  const order: Record<CandidateStatus, number> = { ready: 0, watch: 1, avoid: 2 };
  return [...rows].sort((a, b) => {
    if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
    return (b.score ?? -Infinity) - (a.score ?? -Infinity);
  });
}

function emptySummary(): ScanSummary {
  return { scanned: 0, ready: 0, watch: 0, avoid: 0, errors: 0 };
}

function fmtMoney(v: number | null) {
  return v === null ? "-" : `$${v.toFixed(2)}`;
}
function fmtPct(v: number | null) {
  return v === null ? "-" : `${v.toFixed(1)}%`;
}
function fmtDelta(v: number | null) {
  return v === null ? "-" : Math.abs(v).toFixed(2);
}

export default function Home() {
  const [watchlist, setWatchlist] = useState(DEFAULT_WATCHLIST);
  const [dteMin, setDteMin] = useState(7);
  const [dteMax, setDteMax] = useState(60);
  const [minRoi, setMinRoi] = useState(1);
  const [excludeEarnings, setExcludeEarnings] = useState(true);
  const [earningsDays, setEarningsDays] = useState(14);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ScanResponse | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [fullScanRunning, setFullScanRunning] = useState(false);
  const [fullScanProgress, setFullScanProgress] = useState<{ batch: number; totalBatches: number; scanned: number; total: number } | null>(null);

  const anyScanRunning = loading || fullScanRunning;

  function commonParams() {
    return {
      dteMin: String(dteMin),
      dteMax: String(dteMax),
      minRoi: String(minRoi),
      excludeEarningsDays: String(excludeEarnings ? earningsDays : 0),
    };
  }

  async function runScreener() {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ tickers: watchlist, ...commonParams() });
      const res = await fetch(`/api/screener?${params.toString()}`);
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Screener request failed");
        setData(null);
      } else {
        setData(json);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setLoading(false);
    }
  }

  // Scans the full ~194-ticker universe (lib/watchlist.ts) in small batches so nothing
  // times out and Yahoo never sees more than FULL_SCAN_BATCH_SIZE requests land at once.
  // Results accumulate into the same table batch-by-batch, so you see candidates filling
  // in as it goes instead of staring at a blank screen for several minutes.
  async function runFullUniverseScan() {
    setFullScanRunning(true);
    setError(null);
    setData(null);

    const batches = chunk(FULL_UNIVERSE, FULL_SCAN_BATCH_SIZE);
    let allResults: CspCandidateRow[] = [];
    const summary = emptySummary();
    const params = commonParams();

    for (let i = 0; i < batches.length; i++) {
      setFullScanProgress({ batch: i + 1, totalBatches: batches.length, scanned: i * FULL_SCAN_BATCH_SIZE, total: FULL_UNIVERSE.length });
      try {
        const qs = new URLSearchParams({ tickers: batches[i].join(","), ...params });
        const res = await fetch(`/api/screener?${qs.toString()}`);
        const json = await res.json();
        if (res.ok) {
          allResults = allResults.concat(json.results as CspCandidateRow[]);
          summary.scanned += json.summary.scanned;
          summary.ready += json.summary.ready;
          summary.watch += json.summary.watch;
          summary.avoid += json.summary.avoid;
          summary.errors += json.summary.errors;
        } else {
          // One bad batch shouldn't kill the whole run - record it and keep going.
          for (const t of batches[i]) {
            allResults.push({
              ticker: t, status: "avoid", verdict: null, score: null, price: null, strike: null,
              expiry: null, dte: null, bid: null, roiPct: null, annRoiPct: null, maxPain: null,
              rsi: null, divergence: "none", divergenceNote: null, daysToEarnings: null, delta: null,
              blockReasons: [], skipReason: json.error ?? "Batch request failed",
            });
          }
          summary.scanned += batches[i].length;
          summary.avoid += batches[i].length;
          summary.errors += batches[i].length;
        }
        setData({ scannedAt: new Date().toISOString(), results: sortResults(allResults), summary: { ...summary } });
      } catch (err) {
        setError(err instanceof Error ? `Batch ${i + 1}/${batches.length} failed: ${err.message}` : "Network error mid-scan");
        // Keep going - a transient network error on one batch shouldn't abandon the rest.
      }
      if (i < batches.length - 1) await sleep(FULL_SCAN_BATCH_DELAY_MS);
    }

    setFullScanProgress(null);
    setFullScanRunning(false);
  }

  const results = data?.results ?? [];

  return (
    <div className="page">
      <div className="header">
        <div>
          <div className="eyebrow">The Wheel</div>
          <h1>CSP Screener</h1>
        </div>
        <div className="meta">{data ? `Last scan: ${new Date(data.scannedAt).toLocaleTimeString()}` : "Not yet run"}</div>
      </div>

      <div className="layout">
        <div className="panel">
          <h2>CSP Screener</h2>

          <label className="field">Watchlist</label>
          <textarea value={watchlist} onChange={(e) => setWatchlist(e.target.value)} placeholder="AAPL, MSFT, ..." disabled={anyScanRunning} />

          <div className="row3">
            <div>
              <label className="field">DTE Min</label>
              <input type="number" value={dteMin} onChange={(e) => setDteMin(Number(e.target.value))} disabled={anyScanRunning} />
            </div>
            <div>
              <label className="field">DTE Max</label>
              <input type="number" value={dteMax} onChange={(e) => setDteMax(Number(e.target.value))} disabled={anyScanRunning} />
            </div>
            <div>
              <label className="field">Min ROI %</label>
              <input type="number" value={minRoi} onChange={(e) => setMinRoi(Number(e.target.value))} disabled={anyScanRunning} />
            </div>
          </div>

          <div className="checkbox-row">
            <input type="checkbox" checked={excludeEarnings} onChange={(e) => setExcludeEarnings(e.target.checked)} id="excl" disabled={anyScanRunning} />
            <label htmlFor="excl">Exclude earnings within</label>
            <input
              type="number"
              style={{ width: 56 }}
              value={earningsDays}
              onChange={(e) => setEarningsDays(Number(e.target.value))}
              disabled={!excludeEarnings || anyScanRunning}
            />
            <span>days</span>
          </div>
          <div className="hint">All data (chain, price, bars, earnings) comes from yahoo-finance2 — no API key needed. A missing earnings date never blocks a candidate, it just isn&apos;t cross-checked. Delta is computed (Black-Scholes, from IV) and capped at 0.30 — candidates struck too close to the money are blocked, not just deprioritized.</div>

          <button className="run" onClick={runScreener} disabled={anyScanRunning}>
            {loading ? "Scanning..." : "Run Screener"}
          </button>

          <button className="run run-secondary" onClick={runFullUniverseScan} disabled={anyScanRunning} style={{ marginTop: 8 }}>
            {fullScanRunning ? "Scanning full watchlist..." : `Scan Full Watchlist (${FULL_UNIVERSE.length})`}
          </button>
          <div className="hint">
            Runs every name in the v7 watchlist doc (MU/SLV excluded, DO-NOT-ADD) in batches of {FULL_SCAN_BATCH_SIZE}, {(FULL_SCAN_BATCH_DELAY_MS / 1000).toFixed(1)}s apart, so it won&apos;t time out or trip a Yahoo rate limit. Takes several minutes — results fill in as each batch finishes. Keep this tab open.
          </div>
          {fullScanProgress && (
            <div className="scanner-box">
              <label className="field" style={{ marginTop: 0 }}>Progress</label>
              <div className="scanner-counts">
                <span>Batch {fullScanProgress.batch}/{fullScanProgress.totalBatches}</span>
                <span>~{Math.min(fullScanProgress.scanned, fullScanProgress.total)}/{fullScanProgress.total} scanned</span>
              </div>
            </div>
          )}

          {data && (
            <div className="scanner-box">
              <label className="field" style={{ marginTop: 0 }}>Scanner</label>
              <div className="scanner-counts">
                <span>Ready {data.summary.ready}</span>
                <span>Watch {data.summary.watch}</span>
                <span>Avoid {data.summary.avoid}</span>
                <span>Errors {data.summary.errors}</span>
              </div>
            </div>
          )}
        </div>

        <div>
          {error && <div className="error-banner">{error}</div>}
          {!error && data && (
            <div className="scan-status">
              {fullScanRunning ? "Scanning..." : "Scan complete:"} {data.summary.scanned} tickers checked.
            </div>
          )}

          <div className="panel">
            <div className="candidates-header">
              <h2>Candidates</h2>
              {data && (
                <div className="counts">
                  {data.summary.ready} ready / {data.summary.watch} watch / {data.summary.avoid} avoid
                </div>
              )}
            </div>

            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Ticker</th>
                    <th>Score</th>
                    <th>Status</th>
                    <th>Price</th>
                    <th>Strike</th>
                    <th>Expiry</th>
                    <th>DTE</th>
                    <th>Bid</th>
                    <th>ROI</th>
                    <th>Ann ROI</th>
                    <th>Max Pain</th>
                    <th>RSI</th>
                    <th>Delta</th>
                    <th>Divergence</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {results.length === 0 && (
                    <tr>
                      <td colSpan={15} className="empty-state">
                        {data ? "No candidates returned." : "Run the screener to populate candidates."}
                      </td>
                    </tr>
                  )}
                  {results.map((row) => {
                    const reason = row.skipReason ?? row.blockReasons.join("; ") ?? row.divergenceNote ?? "";
                    return (
                      <tr key={row.ticker} onClick={() => setExpanded(expanded === row.ticker ? null : row.ticker)}>
                        <td><strong>{row.ticker}</strong></td>
                        <td>{row.score ?? "-"}</td>
                        <td>
                          <span className={`status-pill status-${row.status}`}>{row.status.toUpperCase()}</span>
                        </td>
                        <td>{fmtMoney(row.price)}</td>
                        <td>{fmtMoney(row.strike)}</td>
                        <td>{row.expiry ?? "-"}</td>
                        <td>{row.dte ?? "-"}</td>
                        <td>{fmtMoney(row.bid)}</td>
                        <td>{fmtPct(row.roiPct)}</td>
                        <td>{fmtPct(row.annRoiPct)}</td>
                        <td>{fmtMoney(row.maxPain)}</td>
                        <td>{row.rsi !== null ? row.rsi.toFixed(0) : "-"}</td>
                        <td>{fmtDelta(row.delta)}</td>
                        <td className={`divergence-${row.divergence}`}>
                          {row.divergence === "none" ? "-" : row.divergence.toUpperCase()}
                        </td>
                        <td className="reason-cell">{reason}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
