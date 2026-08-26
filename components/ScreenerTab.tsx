"use client";

import { useMemo, useState } from "react";
import { CORE_WATCHLIST, FULL_UNIVERSE, SECTOR_CLUSTERS, UNCLUSTERED, INDUSTRY_SECTORS } from "../lib/watchlist";

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
  iv: number | null;
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

// Two ways to slice the 194-name universe into clickable groups:
// - Theme chips: the v7 doc's investment-thesis clusters (AI Infra, Space/Defense, etc.) -
//   these overlap (a ticker can be in more than one) and only tag about half the universe,
//   so there's an "Other" catch-all for names with no clean thesis.
// - Industry chips: a complete, non-overlapping industry classification covering all 194
//   names - this is the literal "sort into industry buckets" view.
const THEME_CHIPS = [
  ...SECTOR_CLUSTERS,
  ...(UNCLUSTERED.length ? [{ name: "Other", tickers: UNCLUSTERED }] : []),
];
const INDUSTRY_CHIPS = INDUSTRY_SECTORS;

// Same 8-per-batch / throttled pattern as scripts/full-scan.ts, just driven from the
// browser instead of a terminal, so a big scan doesn't time out a single serverless
// request or fire a wall of tickers at Yahoo all at once.
const BATCH_SIZE = 8;
const BATCH_DELAY_MS = 2500;

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

// --- Column sorting -----------------------------------------------------
// Every data column is click-to-sort (the Reason column is left out - it's
// free text, not a value with a meaningful order). Standard table-sort UX:
// first click on a column sorts by that column using its own sensible
// default direction (e.g. Score defaults to highest-first, RSI defaults to
// lowest-first since oversold is what a wheel trader is hunting for);
// clicking the same column again flips direction; nulls always sort to the
// bottom no matter the direction, so missing data never masquerades as a
// "highest" or "lowest" value. With no column selected yet, the table falls
// back to the smart default (status group, then score) via sortResults above.
type SortDirection = "asc" | "desc";
type SortableKey =
  | "ticker" | "score" | "status" | "price" | "strike" | "expiry" | "dte" | "bid"
  | "roiPct" | "annRoiPct" | "maxPain" | "rsi" | "delta" | "iv" | "divergence";
type SortState = { key: SortableKey; direction: SortDirection };

const STATUS_RANK: Record<CandidateStatus, number> = { ready: 0, watch: 1, avoid: 2 };
const DIVERGENCE_RANK: Record<CspCandidateRow["divergence"], number> = { bullish: 0, none: 1, bearish: 2 };

const SORT_COLUMNS: Record<SortableKey, { label: string; getValue: (row: CspCandidateRow) => string | number | null; defaultDirection: SortDirection }> = {
  ticker: { label: "Ticker", getValue: (r) => r.ticker, defaultDirection: "asc" },
  score: { label: "Score", getValue: (r) => r.score, defaultDirection: "desc" },
  status: { label: "Status", getValue: (r) => STATUS_RANK[r.status], defaultDirection: "asc" },
  price: { label: "Price", getValue: (r) => r.price, defaultDirection: "desc" },
  strike: { label: "Strike", getValue: (r) => r.strike, defaultDirection: "desc" },
  expiry: { label: "Expiry", getValue: (r) => r.expiry, defaultDirection: "asc" },
  dte: { label: "DTE", getValue: (r) => r.dte, defaultDirection: "asc" },
  bid: { label: "Bid", getValue: (r) => r.bid, defaultDirection: "desc" },
  roiPct: { label: "ROI", getValue: (r) => r.roiPct, defaultDirection: "desc" },
  annRoiPct: { label: "Ann ROI", getValue: (r) => r.annRoiPct, defaultDirection: "desc" },
  maxPain: { label: "Max Pain", getValue: (r) => r.maxPain, defaultDirection: "desc" },
  rsi: { label: "RSI", getValue: (r) => r.rsi, defaultDirection: "asc" },
  delta: { label: "Delta", getValue: (r) => (r.delta === null ? null : Math.abs(r.delta)), defaultDirection: "asc" },
  iv: { label: "IV", getValue: (r) => r.iv, defaultDirection: "desc" },
  divergence: { label: "Divergence", getValue: (r) => DIVERGENCE_RANK[r.divergence], defaultDirection: "asc" },
};

function compareValues(a: string | number | null, b: string | number | null, direction: SortDirection): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1; // nulls always last, regardless of sort direction
  if (b === null) return -1;
  const cmp = typeof a === "string" && typeof b === "string" ? a.localeCompare(b) : (a as number) - (b as number);
  return direction === "asc" ? cmp : -cmp;
}

function sortByColumn(rows: CspCandidateRow[], key: SortableKey, direction: SortDirection): CspCandidateRow[] {
  const getValue = SORT_COLUMNS[key].getValue;
  return [...rows].sort((a, b) => compareValues(getValue(a), getValue(b), direction));
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
function fmtIv(v: number | null) {
  return v === null ? "-" : `${v.toFixed(0)}%`;
}

export function ScreenerTab() {
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
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchLabel, setBatchLabel] = useState<string | null>(null);
  const [batchProgress, setBatchProgress] = useState<{ batch: number; totalBatches: number; scanned: number; total: number } | null>(null);
  const [lastScanLabel, setLastScanLabel] = useState<string | null>(null);
  const [sortState, setSortState] = useState<SortState | null>(null);

  const anyScanRunning = loading || batchRunning;

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
        setLastScanLabel("Custom watchlist");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setLoading(false);
    }
  }

  // Scans an arbitrary ticker list (the full universe, or one sector bucket) in small
  // batches so nothing times out and Yahoo never sees more than BATCH_SIZE requests land
  // at once. Results accumulate into the same table batch-by-batch, so you see candidates
  // filling in as it goes instead of staring at a blank screen for several minutes.
  async function runBatchedScan(tickers: string[], label: string) {
    setBatchRunning(true);
    setBatchLabel(label);
    setError(null);
    setData(null);

    const batches = chunk(tickers, BATCH_SIZE);
    let allResults: CspCandidateRow[] = [];
    const summary = emptySummary();
    const params = commonParams();

    for (let i = 0; i < batches.length; i++) {
      setBatchProgress({ batch: i + 1, totalBatches: batches.length, scanned: i * BATCH_SIZE, total: tickers.length });
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
              rsi: null, divergence: "none", divergenceNote: null, daysToEarnings: null, delta: null, iv: null,
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
      if (i < batches.length - 1) await sleep(BATCH_DELAY_MS);
    }

    setBatchProgress(null);
    setBatchRunning(false);
    setLastScanLabel(label);
  }

  const results = data?.results ?? [];

  // Column click sorts by that column; clicking the already-active column flips
  // direction. Falls back to the status/score default until a column is picked.
  function handleSortClick(key: SortableKey) {
    setSortState((prev) =>
      prev && prev.key === key ? { key, direction: prev.direction === "asc" ? "desc" : "asc" } : { key, direction: SORT_COLUMNS[key].defaultDirection },
    );
  }

  function sortIndicator(key: SortableKey) {
    if (!sortState || sortState.key !== key) return null;
    return <span className="sort-arrow">{sortState.direction === "asc" ? "▲" : "▼"}</span>;
  }

  const displayResults = useMemo(
    () => (sortState ? sortByColumn(results, sortState.key, sortState.direction) : results),
    [results, sortState],
  );

  return (
    <>
      <div className="tab-meta-bar">
        <h2 className="tab-meta-title">CSP Screener</h2>
        <div className="meta">
          {data ? `Last scan: ${lastScanLabel ?? ""} · ${new Date(data.scannedAt).toLocaleTimeString()}` : "Not yet run"}
        </div>
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
          <div className="hint">All data (chain, price, bars, earnings) comes from yahoo-finance2 — no API key needed. A missing earnings date never blocks a candidate, it just isn&apos;t cross-checked. Delta is computed (Black-Scholes, from IV) and capped at 0.30 — candidates struck too close to the money are blocked, not just deprioritized. IV is the contract&apos;s implied volatility straight from the chain, shown as an annualized percentage.</div>

          <button className="run" onClick={runScreener} disabled={anyScanRunning}>
            {loading ? "Scanning..." : "Run Screener"}
          </button>

          <button
            className="run run-secondary"
            onClick={() => runBatchedScan(FULL_UNIVERSE, `Full Watchlist (${FULL_UNIVERSE.length})`)}
            disabled={anyScanRunning}
            style={{ marginTop: 8 }}
          >
            {batchRunning && batchLabel?.startsWith("Full Watchlist") ? "Scanning full watchlist..." : `Scan Full Watchlist (${FULL_UNIVERSE.length})`}
          </button>
          <div className="hint">
            Runs every name in the v7 watchlist doc (MU/SLV excluded, DO-NOT-ADD) in batches of {BATCH_SIZE}, {(BATCH_DELAY_MS / 1000).toFixed(1)}s apart, so it won&apos;t time out or trip a Yahoo rate limit. Takes several minutes — results fill in as each batch finishes. Keep this tab open.
          </div>

          <label className="field">Scan by Industry</label>
          <div className="sector-chips">
            {INDUSTRY_CHIPS.map((cluster) => (
              <button
                key={cluster.name}
                type="button"
                className="chip"
                disabled={anyScanRunning}
                onClick={() => runBatchedScan(cluster.tickers, `${cluster.name} (${cluster.tickers.length})`)}
              >
                {batchRunning && batchLabel === `${cluster.name} (${cluster.tickers.length})` ? "Scanning..." : `${cluster.name} (${cluster.tickers.length})`}
              </button>
            ))}
          </div>
          <div className="hint">Every one of the 194 names sorted into one industry bucket, no overlaps. Click a bucket and it scans immediately (same batching as the full scan).</div>

          <label className="field">Scan by Theme</label>
          <div className="sector-chips">
            {THEME_CHIPS.map((cluster) => (
              <button
                key={cluster.name}
                type="button"
                className="chip"
                disabled={anyScanRunning}
                onClick={() => runBatchedScan(cluster.tickers, `${cluster.name} (${cluster.tickers.length})`)}
              >
                {batchRunning && batchLabel === `${cluster.name} (${cluster.tickers.length})` ? "Scanning..." : `${cluster.name} (${cluster.tickers.length})`}
              </button>
            ))}
          </div>
          <div className="hint">The v7 doc's investment-thesis groupings (AI Infra, Space/Defense, Crypto, etc.) — these overlap by design, and &quot;Other&quot; catches names with no clean thesis.</div>

          {batchProgress && (
            <div className="scanner-box">
              <label className="field" style={{ marginTop: 0 }}>Progress ({batchLabel})</label>
              <div className="scanner-counts">
                <span>Batch {batchProgress.batch}/{batchProgress.totalBatches}</span>
                <span>~{Math.min(batchProgress.scanned, batchProgress.total)}/{batchProgress.total} scanned</span>
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
              {batchRunning ? "Scanning..." : "Scan complete:"} {lastScanLabel} — {data.summary.scanned} tickers checked.
            </div>
          )}

          <div className="panel">
            <div className="candidates-header">
              <h2>Candidates</h2>
              {data && (
                <div className="counts">
                  {data.summary.ready} ready / {data.summary.watch} watch / {data.summary.avoid} avoid
                  {sortState && (
                    <>
                      {" · sorted by "}
                      {SORT_COLUMNS[sortState.key].label.toLowerCase()} ({sortState.direction === "asc" ? "low to high" : "high to low"})
                      <button type="button" className="sort-reset" onClick={() => setSortState(null)}>
                        reset
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
            <div className="hint" style={{ marginTop: -6, marginBottom: 8 }}>Click any column header to sort by it — click again to flip direction.</div>

            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    {(Object.keys(SORT_COLUMNS) as SortableKey[]).map((key) => (
                      <th
                        key={key}
                        className="sortable"
                        aria-sort={sortState?.key === key ? (sortState.direction === "asc" ? "ascending" : "descending") : "none"}
                      >
                        <button type="button" className="th-sort-btn" onClick={() => handleSortClick(key)}>
                          {SORT_COLUMNS[key].label}
                          {sortIndicator(key)}
                        </button>
                      </th>
                    ))}
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {displayResults.length === 0 && (
                    <tr>
                      <td colSpan={16} className="empty-state">
                        {data ? "No candidates returned." : "Run the screener to populate candidates."}
                      </td>
                    </tr>
                  )}
                  {displayResults.map((row) => {
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
                        <td>{fmtIv(row.iv)}</td>
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
    </>
  );
}
