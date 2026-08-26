"use client";

import { useState } from "react";
import { CORE_WATCHLIST } from "../lib/watchlist";

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
  blockReasons: string[];
  skipReason: string | null;
};

type ScanResponse = {
  scannedAt: string;
  results: CspCandidateRow[];
  summary: { scanned: number; ready: number; watch: number; avoid: number; errors: number };
};

// Your Tier 1-3 core watchlist (v7 doc), DO-NOT-ADD names already excluded. The full
// ~194-name universe is scanned separately via scripts/full-scan.ts — that one's batched
// and throttled so it doesn't time out a serverless request or trip Yahoo's rate limit.
const DEFAULT_WATCHLIST = CORE_WATCHLIST.join(", ");

function fmtMoney(v: number | null) {
  return v === null ? "-" : `$${v.toFixed(2)}`;
}
function fmtPct(v: number | null) {
  return v === null ? "-" : `${v.toFixed(1)}%`;
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

  async function runScreener() {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        tickers: watchlist,
        dteMin: String(dteMin),
        dteMax: String(dteMax),
        minRoi: String(minRoi),
        excludeEarningsDays: String(excludeEarnings ? earningsDays : 0),
      });
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
          <textarea value={watchlist} onChange={(e) => setWatchlist(e.target.value)} placeholder="AAPL, MSFT, ..." />

          <div className="row3">
            <div>
              <label className="field">DTE Min</label>
              <input type="number" value={dteMin} onChange={(e) => setDteMin(Number(e.target.value))} />
            </div>
            <div>
              <label className="field">DTE Max</label>
              <input type="number" value={dteMax} onChange={(e) => setDteMax(Number(e.target.value))} />
            </div>
            <div>
              <label className="field">Min ROI %</label>
              <input type="number" value={minRoi} onChange={(e) => setMinRoi(Number(e.target.value))} />
            </div>
          </div>

          <div className="checkbox-row">
            <input type="checkbox" checked={excludeEarnings} onChange={(e) => setExcludeEarnings(e.target.checked)} id="excl" />
            <label htmlFor="excl">Exclude earnings within</label>
            <input
              type="number"
              style={{ width: 56 }}
              value={earningsDays}
              onChange={(e) => setEarningsDays(Number(e.target.value))}
              disabled={!excludeEarnings}
            />
            <span>days</span>
          </div>
          <div className="hint">All data (chain, price, bars, earnings) comes from yahoo-finance2 — no API key needed. A missing earnings date never blocks a candidate, it just isn&apos;t cross-checked.</div>

          <button className="run" onClick={runScreener} disabled={loading}>
            {loading ? "Scanning..." : "Run Screener"}
          </button>

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
            <div className="scan-status">Scan complete: {data.summary.scanned} tickers checked.</div>
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
                    <th>Divergence</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {results.length === 0 && (
                    <tr>
                      <td colSpan={14} className="empty-state">
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
