"use client";

import { useMemo, useState } from "react";
import { Activity, Link2, RefreshCw, Search, ShieldCheck, WalletCards } from "lucide-react";
import type { AccountSnapshot, OptionContract, ScreenerCandidate, WheelPosition } from "@/lib/types";
import { dteFromExpiry, fmtPct, fmtUsd } from "@/lib/wheel/math";

type DashboardProps = {
  userEmail: string | null;
  account: AccountSnapshot;
  positions: WheelPosition[];
  watchlist: string[];
  isConfigured: boolean;
  missingSnapTradeEnv?: string[];
};

type ScanStatus = {
  total: number;
  completed: number;
  currentTicker: string;
  candidates: number;
  blocked: number;
  errors: number;
  lastMessage: string;
};

export function Dashboard({ userEmail, account, positions, watchlist, missingSnapTradeEnv = [] }: DashboardProps) {
  const [tickers, setTickers] = useState(watchlist.join(", "));
  const [candidates, setCandidates] = useState<ScreenerCandidate[]>([]);
  const [status, setStatus] = useState("");
  const [isScanning, setIsScanning] = useState(false);
  const [dteMin, setDteMin] = useState(7);
  const [dteMax, setDteMax] = useState(60);
  const [minRoi, setMinRoi] = useState(1);
  const [scanStatus, setScanStatus] = useState<ScanStatus>({
    total: 0,
    completed: 0,
    currentTicker: "",
    candidates: 0,
    blocked: 0,
    errors: 0,
    lastMessage: ""
  });

  const totalGain = useMemo(() => positions.reduce((sum, pos) => sum + (pos.gainUsd ?? 0), 0), [positions]);
  const atRisk = useMemo(
    () => positions.filter((pos) => pos.kind !== "stock" && pos.expiry && dteFromExpiry(pos.expiry) <= 7).length,
    [positions]
  );
  const floorGap = account.accountValue - account.floor;
  const scanProgressPct = scanStatus.total ? Math.round((scanStatus.completed / scanStatus.total) * 100) : 0;

  async function syncSnapTrade() {
    if (missingSnapTradeEnv.length) {
      setStatus(`SnapTrade needs: ${missingSnapTradeEnv.join(", ")}`);
      return;
    }
    setStatus("Syncing SnapTrade...");
    const response = await fetch("/api/snaptrade/sync", { method: "POST" });
    const data = await response.json();
    if (!response.ok) {
      setStatus(data.error ?? "SnapTrade sync failed");
      return;
    }
    setStatus(`Synced ${data.positionCount} positions. Refreshing...`);
    window.location.reload();
  }

  async function connectSnapTrade() {
    if (missingSnapTradeEnv.length) {
      setStatus(`SnapTrade needs: ${missingSnapTradeEnv.join(", ")}`);
      return;
    }
    setStatus("Creating SnapTrade login link...");
    const response = await fetch("/api/snaptrade/login", { method: "POST" });
    const data = await response.json();
    if (!response.ok || !data.redirectURI) {
      setStatus(data.error ?? "SnapTrade login link failed");
      return;
    }
    window.location.href = data.redirectURI;
  }

  async function runScan() {
    setIsScanning(true);
    try {
      setStatus("Scanning watchlist through server-side yfinance routes...");
      const symbols = tickers
        .split(",")
        .map((ticker) => ticker.trim().toUpperCase())
        .filter(Boolean)
        .slice(0, 16);

      const rows: ScreenerCandidate[] = [];
      const progress = {
        total: symbols.length,
        completed: 0,
        currentTicker: symbols[0] ?? "",
        candidates: 0,
        blocked: 0,
        errors: 0,
        lastMessage: symbols.length ? "Preparing scan..." : "No tickers to scan."
      };
      setScanStatus(progress);

      for (const ticker of symbols) {
        progress.currentTicker = ticker;
        progress.lastMessage = `Scanning ${ticker}...`;
        setScanStatus({ ...progress });
        try {
          const params = new URLSearchParams({
            ticker,
            dteMin: String(dteMin),
            dteMax: String(dteMax)
          });
          const response = await fetch(`/api/yahoo/options?${params.toString()}`);
          const data = await response.json();
          if (!response.ok) throw new Error(data.error ?? "scan failed");
          const quote = data.quote;
          const price = typeof quote.price === "number" ? quote.price : null;
          const options = data.options as OptionContract[];
          const maxPain = typeof data.maxPain === "number" ? data.maxPain : null;
          if (!price || price <= 0) {
            throw new Error("Market data failed: invalid price");
          }
          if (maxPain === null) {
            throw new Error("Max pain calc failed: no OI data");
          }

          const puts = options.filter((option) => option.kind === "put" && option.strike < price);
          const putStrikes = Array.from(new Set(puts.map((option) => option.strike))).sort((a, b) => a - b);
          if (!putStrikes.length) {
            throw new Error("No OTM put strikes");
          }
          const targetStrike = putStrikes.reduce((best, strike) =>
            Math.abs(strike - maxPain * 0.95) < Math.abs(best - maxPain * 0.95) ? strike : best
          );
          const liveContracts = puts
            .filter((option) => Math.abs(option.strike - targetStrike) <= 0.01)
            .filter((option) => option.bid !== null && option.ask !== null)
            .filter((option) => Number(option.bid) > 0 && Number(option.ask) > 0 && Number(option.bid) <= Number(option.ask))
            .sort((a, b) => Number(b.bid ?? 0) - Number(a.bid ?? 0));
          const put = liveContracts[0];
          if (!put) {
            throw new Error("No live two-sided bid at target strike");
          }

          const strike = put.strike;
          const bid = Number(put.bid);
          const ask = Number(put.ask);
          const mid = (bid + ask) / 2;
          const spreadPct = mid > 0 ? ((ask - bid) / mid) * 100 : null;
          const dte = dteFromExpiry(put.expiry);
          const roiPct = strike ? (bid / strike) * 100 : null;
          if (roiPct === null || roiPct < minRoi) {
            throw new Error(`ROI ${roiPct?.toFixed(2) ?? "-"}% < min ${minRoi.toFixed(1)}%`);
          }
          const annRoiPct = roiPct !== null && dte > 0 ? (roiPct * 365) / dte : null;
          const ivRank = estimateIvRank(options, price);
          const rsi14 = typeof data.technicals?.rsi14 === "number" ? data.technicals.rsi14 : null;
          const wk52Pos = typeof data.technicals?.wk52_pos === "number" ? data.technicals.wk52_pos : null;
          const maxPainGapPct = maxPain ? ((strike - maxPain) / maxPain) * 100 : null;
          const rule6 = quote.changePct === null ? "UNKNOWN" : quote.changePct < 0 ? "RED" : "GREEN";
          const capacity = account.cashSecuredPutCapacity ?? account.buyingPower ?? account.accountValue;
          const concentrationPct = account.accountValue ? ((strike * 100) / account.accountValue) * 100 : 0;
          const gate0 = capacity > 0 && price > capacity * 0.2 ? "BLOCK" : concentrationPct > 20 ? "WARN" : "PASS";
          const optionVolume = put.volume ?? null;
          const score = scoreCspCandidate({
            annRoiPct,
            ivRank,
            spreadPct,
            openInterest: put.openInterest,
            optionVolume,
            rsi14,
            wk52Pos,
            chgPct: rule6 === "UNKNOWN" ? null : quote.changePct,
            gate0
          });
          const strategyLane = dte <= 6 ? "DEFENSE" : dte <= 21 ? "SNIPER_CSP" : dte >= 30 && dte <= 50 ? "STANDARD_CSP" : "OUT_OF_LANE";
          const laneStatus =
            rule6 === "GREEN" || score < 60
              ? "AVOID"
              : rule6 === "UNKNOWN"
                ? "WATCH"
                : strategyLane === "STANDARD_CSP" && score >= 75
                  ? "ALERT_READY"
                  : strategyLane === "SNIPER_CSP" && score >= 80
                    ? "ALERT_READY"
                    : "WATCH";
          rows.push({
            ticker,
            price,
            changePct: quote.changePct,
            quoteQuality: quote.quality,
            strike,
            expiry: put.expiry,
            dte,
            bid,
            ask,
            mid,
            spreadPct,
            openInterest: put.openInterest,
            optionVolume,
            ivRank,
            rsi14,
            wk52Pos,
            laneStatus,
            strategyLane,
            roiPct,
            annRoiPct,
            maxPain,
            maxPainGapPct,
            rule6,
            gate0,
            score,
            decisionReason: decisionReason(rule6, ivRank, strike, maxPain, spreadPct, gate0)
          });
          progress.candidates += 1;
          progress.lastMessage = `${ticker}: ${fmtUsd(strike)} ${put.expiry} bid ${fmtUsd(bid)}, ROI ${fmtPct(roiPct)}.`;
        } catch (error) {
          progress.errors += 1;
          progress.blocked += 1;
          progress.lastMessage = `${ticker}: ${error instanceof Error ? error.message : "Scan failed"}`;
          rows.push({
            ticker,
            price: null,
            changePct: null,
            quoteQuality: "MISSING",
            strike: 0,
            expiry: "-",
            dte: 0,
            bid: null,
            ask: null,
            mid: null,
            spreadPct: null,
            openInterest: null,
            optionVolume: null,
            ivRank: null,
            rsi14: null,
            wk52Pos: null,
            laneStatus: "AVOID",
            strategyLane: "OUT_OF_LANE",
            roiPct: null,
            annRoiPct: null,
            maxPain: null,
            maxPainGapPct: null,
            rule6: "UNKNOWN",
            gate0: "BLOCK",
            score: -100,
            decisionReason: error instanceof Error ? error.message : "Scan failed"
          });
        }
        progress.completed += 1;
        progress.currentTicker = progress.completed < progress.total ? symbols[progress.completed] : "";
        setScanStatus({ ...progress });
      }
      setCandidates(rows.sort((a, b) => b.score - a.score));
      setStatus(`Scan complete: ${rows.length} tickers checked.`);
      setScanStatus({
        ...progress,
        currentTicker: "",
        lastMessage: `Scan complete: ${progress.candidates} candidates, ${progress.blocked} blocked/skipped.`
      });
    } finally {
      setIsScanning(false);
    }
  }

  return (
    <main className="min-h-screen bg-canvas">
      <header className="border-b border-line bg-panel">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div>
            <p className="text-xs font-semibold uppercase text-accent">The Wheel</p>
            <h1 className="text-2xl font-semibold text-ink">Treasury command center</h1>
          </div>
          <div className="flex items-center gap-2">
            {userEmail ? (
              <span className="hidden max-w-[220px] truncate rounded-md bg-slate-100 px-3 py-2 text-sm font-semibold text-muted md:inline">
                {userEmail}
              </span>
            ) : null}
            <button
              className="inline-flex h-9 items-center gap-2 rounded-md border border-line bg-white px-3 text-sm font-semibold text-ink"
              onClick={connectSnapTrade}
              disabled={Boolean(missingSnapTradeEnv.length)}
            >
              <Link2 size={16} />
              Connect
            </button>
            <button
              className="inline-flex h-9 items-center gap-2 rounded-md bg-accent px-3 text-sm font-semibold text-white"
              onClick={syncSnapTrade}
              disabled={Boolean(missingSnapTradeEnv.length)}
            >
              <RefreshCw size={16} />
              Sync
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-6 py-6">
        <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          <Metric icon={<WalletCards size={18} />} label="Broker Total" value={fmtUsd(account.accountValue)} />
          <Metric
            icon={<ShieldCheck size={18} />}
            label="Floor Cushion"
            value={fmtUsd(floorGap, true)}
            tone={floorGap >= 0 ? "success" : "danger"}
          />
          <Metric
            icon={<Activity size={18} />}
            label="Open P&L"
            value={fmtUsd(totalGain, true)}
            tone={totalGain >= 0 ? "success" : "danger"}
          />
          <Metric icon={<Search size={18} />} label="Positions" value={String(positions.length)} />
          <Metric label="Action Needed" value={String(atRisk)} tone={atRisk ? "danger" : "success"} />
        </section>

        <section className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="rounded-lg border border-line bg-panel shadow-soft">
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <div>
                <h2 className="font-semibold text-ink">Position review</h2>
                <p className="text-xs text-muted">
                  {account.source ?? "not connected"} {account.syncedAt ? `- ${new Date(account.syncedAt).toLocaleString()}` : ""}
                </p>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[780px] text-left text-sm">
                <thead className="border-b border-line bg-slate-50 text-xs uppercase text-muted">
                  <tr>
                    <th className="px-4 py-3">Symbol</th>
                    <th className="px-4 py-3">Kind</th>
                    <th className="px-4 py-3 text-right">Qty</th>
                    <th className="px-4 py-3 text-right">Mark</th>
                    <th className="px-4 py-3 text-right">P&L</th>
                    <th className="px-4 py-3">Expiry</th>
                    <th className="px-4 py-3">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.length ? (
                    positions.map((pos) => (
                      <tr key={pos.id ?? `${pos.symbol}-${pos.expiry}`} className="border-b border-line last:border-0">
                        <td className="px-4 py-3 font-semibold text-ink">{pos.symbol ?? pos.ticker}</td>
                        <td className="px-4 py-3 capitalize text-muted">{pos.kind}</td>
                        <td className="px-4 py-3 text-right tabular">{pos.quantity}</td>
                        <td className="px-4 py-3 text-right tabular">{fmtUsd(pos.price)}</td>
                        <td className="px-4 py-3 text-right tabular">{fmtUsd(pos.gainUsd, true)}</td>
                        <td className="px-4 py-3 text-muted">{pos.expiry ?? "-"}</td>
                        <td className="px-4 py-3">
                          <StatusPill tone={pos.expiry && dteFromExpiry(pos.expiry) <= 7 ? "danger" : "success"}>
                            {pos.expiry && dteFromExpiry(pos.expiry) <= 7 ? "Review" : "OK"}
                          </StatusPill>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={7} className="px-4 py-10 text-center text-muted">
                        No positions synced yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <aside className="rounded-lg border border-line bg-panel p-4 shadow-soft">
            <h2 className="font-semibold text-ink">Wheel screener</h2>
            <p className="mt-1 text-sm text-muted">Server-side yfinance scan for CSP candidates.</p>
            <label className="mt-4 block text-xs font-semibold uppercase text-muted" htmlFor="watchlist">
              Watchlist
            </label>
            <textarea
              id="watchlist"
              className="mt-2 min-h-28 w-full rounded-md border border-line p-3 text-sm outline-none focus:border-accent"
              value={tickers}
              onChange={(event) => setTickers(event.target.value)}
            />
            <div className="mt-3 grid grid-cols-3 gap-2">
              <label className="block text-xs font-semibold uppercase text-muted" htmlFor="dte-min">
                DTE Min
                <input
                  id="dte-min"
                  type="number"
                  min={1}
                  className="mt-1 h-9 w-full rounded-md border border-line px-2 text-sm font-normal text-ink outline-none focus:border-accent"
                  value={dteMin}
                  onChange={(event) => setDteMin(Number(event.target.value))}
                />
              </label>
              <label className="block text-xs font-semibold uppercase text-muted" htmlFor="dte-max">
                DTE Max
                <input
                  id="dte-max"
                  type="number"
                  min={1}
                  className="mt-1 h-9 w-full rounded-md border border-line px-2 text-sm font-normal text-ink outline-none focus:border-accent"
                  value={dteMax}
                  onChange={(event) => setDteMax(Number(event.target.value))}
                />
              </label>
              <label className="block text-xs font-semibold uppercase text-muted" htmlFor="min-roi">
                Min ROI
                <input
                  id="min-roi"
                  type="number"
                  min={0}
                  step={0.1}
                  className="mt-1 h-9 w-full rounded-md border border-line px-2 text-sm font-normal text-ink outline-none focus:border-accent"
                  value={minRoi}
                  onChange={(event) => setMinRoi(Number(event.target.value))}
                />
              </label>
            </div>
            <button
              onClick={runScan}
              disabled={isScanning}
              className="mt-3 inline-flex h-9 w-full items-center justify-center gap-2 rounded-md bg-ink px-3 text-sm font-semibold text-white disabled:opacity-60"
            >
              <Search size={16} />
              {isScanning ? "Scanning" : "Run screener"}
            </button>
            {status ? <p className="mt-3 text-sm text-muted">{status}</p> : null}
            {scanStatus.total > 0 ? (
              <div className="mt-3 rounded-md border border-line bg-slate-50 p-3">
                <div className="flex items-center justify-between gap-3 text-xs font-semibold uppercase text-muted">
                  <span>{isScanning ? `Scanning ${scanStatus.currentTicker || "..."}` : "Scanner"}</span>
                  <span className="tabular">
                    {scanStatus.completed}/{scanStatus.total}
                  </span>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-white ring-1 ring-line">
                  <div
                    className="h-full rounded-full bg-accent transition-all"
                    style={{ width: `${scanProgressPct}%` }}
                  />
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                  <span className="rounded bg-white px-2 py-1 text-success ring-1 ring-line">
                    Found <b className="tabular">{scanStatus.candidates}</b>
                  </span>
                  <span className="rounded bg-white px-2 py-1 text-warning ring-1 ring-line">
                    Blocked <b className="tabular">{scanStatus.blocked}</b>
                  </span>
                  <span className="rounded bg-white px-2 py-1 text-danger ring-1 ring-line">
                    Errors <b className="tabular">{scanStatus.errors}</b>
                  </span>
                </div>
                <p className="mt-2 text-xs text-muted">{scanStatus.lastMessage}</p>
              </div>
            ) : null}
            {missingSnapTradeEnv.length ? (
              <p className="mt-3 rounded-md bg-amber-50 p-3 text-sm text-warning">
                SnapTrade sync is disabled until these environment variables are set: {missingSnapTradeEnv.join(", ")}.
              </p>
            ) : null}
          </aside>
        </section>

        <section className="mt-6 rounded-lg border border-line bg-panel shadow-soft">
          <div className="border-b border-line px-4 py-3">
            <h2 className="font-semibold text-ink">CSP candidates</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1320px] text-left text-sm">
              <thead className="border-b border-line bg-slate-50 text-xs uppercase text-muted">
                <tr>
                  <th className="px-4 py-3">Ticker</th>
                  <th className="px-4 py-3 text-right">Price</th>
                  <th className="px-4 py-3 text-right">Chg</th>
                  <th className="px-4 py-3">Rule 6</th>
                  <th className="px-4 py-3 text-right">Strike</th>
                  <th className="px-4 py-3">Expiry</th>
                  <th className="px-4 py-3 text-right">DTE</th>
                  <th className="px-4 py-3 text-right">Bid</th>
                  <th className="px-4 py-3 text-right">Ask</th>
                  <th className="px-4 py-3 text-right">Spread</th>
                  <th className="px-4 py-3 text-right">ROI</th>
                  <th className="px-4 py-3 text-right">Ann ROI</th>
                  <th className="px-4 py-3 text-right">IVR</th>
                  <th className="px-4 py-3 text-right">OI</th>
                  <th className="px-4 py-3 text-right">Max Pain</th>
                  <th className="px-4 py-3 text-right">MP Gap</th>
                  <th className="px-4 py-3 text-right">Score</th>
                  <th className="px-4 py-3">Reason</th>
                </tr>
              </thead>
              <tbody>
                {candidates.length ? (
                  candidates.map((row) => (
                    <tr key={`${row.ticker}-${row.expiry}-${row.strike}`} className="border-b border-line last:border-0">
                      <td className="px-4 py-3 font-semibold">{row.ticker}</td>
                      <td className="px-4 py-3 text-right tabular">{fmtUsd(row.price)}</td>
                      <td className="px-4 py-3 text-right tabular">{fmtPct(row.changePct, true)}</td>
                      <td className="px-4 py-3">
                        <StatusPill tone={row.rule6 === "RED" ? "success" : row.rule6 === "GREEN" ? "warning" : "neutral"}>
                          {row.rule6}
                        </StatusPill>
                      </td>
                      <td className="px-4 py-3 text-right tabular">{fmtUsd(row.strike)}</td>
                      <td className="px-4 py-3">{row.expiry}</td>
                      <td className="px-4 py-3 text-right tabular">{row.dte}</td>
                      <td className="px-4 py-3 text-right tabular">{fmtUsd(row.bid)}</td>
                      <td className="px-4 py-3 text-right tabular">{fmtUsd(row.ask)}</td>
                      <td className="px-4 py-3 text-right tabular">{fmtPct(row.spreadPct)}</td>
                      <td className="px-4 py-3 text-right tabular">{fmtPct(row.roiPct)}</td>
                      <td className="px-4 py-3 text-right tabular">{fmtPct(row.annRoiPct)}</td>
                      <td className="px-4 py-3 text-right tabular">{row.ivRank === null ? "-" : row.ivRank.toFixed(0)}</td>
                      <td className="px-4 py-3 text-right tabular">{row.openInterest ?? "-"}</td>
                      <td className="px-4 py-3 text-right tabular">{fmtUsd(row.maxPain)}</td>
                      <td className="px-4 py-3 text-right tabular">{fmtPct(row.maxPainGapPct)}</td>
                      <td className="px-4 py-3 text-right tabular font-semibold">{row.score.toFixed(1)}</td>
                      <td className="px-4 py-3 text-muted">{row.decisionReason}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={18} className="px-4 py-10 text-center text-muted">
                      Run the screener to populate candidates.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}

function estimateIvRank(options: OptionContract[], price: number): number | null {
  const atmPut = options
    .filter((option) => option.kind === "put" && typeof option.impliedVolatility === "number" && option.impliedVolatility > 0)
    .sort((a, b) => Math.abs(a.strike - price) - Math.abs(b.strike - price))[0];
  if (!atmPut?.impliedVolatility) return null;
  return Math.min(100, atmPut.impliedVolatility * 100);
}

function scoreCspCandidate(input: {
  annRoiPct: number | null;
  ivRank: number | null;
  spreadPct: number | null;
  openInterest: number | null;
  optionVolume: number | null;
  rsi14: number | null;
  wk52Pos: number | null;
  chgPct: number | null;
  gate0: ScreenerCandidate["gate0"];
}) {
  let score = 0;
  const ivr = input.ivRank;
  if (ivr !== null) {
    if (ivr >= 70) score += 25;
    else if (ivr > 20) score += (ivr - 20) * (25 / 50);
  }

  const sp = input.spreadPct;
  if (sp !== null) {
    if (sp <= 5) score += 10;
    else if (sp <= 10) score += 7;
    else if (sp <= 15) score += 3;
  }

  const oi = input.openInterest ?? 0;
  if (oi >= 500) score += 5;
  else if (oi >= 100) score += 3;
  else if (oi > 0) score += 1;

  const vol = input.optionVolume ?? 0;
  if (vol >= 100) score += 5;
  else if (vol >= 25) score += 3;
  else if (vol > 0) score += 1;

  const pos = input.wk52Pos;
  if (pos !== null) {
    if (pos <= 20) score += 0;
    else if (pos <= 40) score += 8;
    else if (pos <= 70) score += 20;
    else if (pos <= 85) score += 12;
    else score += 6;
  }

  const ann = input.annRoiPct;
  if (ann !== null) {
    if (ann >= 10 && ann < 20) score += 4;
    else if (ann >= 20 && ann < 35) score += 8;
    else if (ann >= 35 && ann < 75) score += 15;
    else if (ann >= 75 && ann <= 100) score += 8;
    else if (ann > 100) score += 3;
  }

  const chg = input.chgPct;
  if (chg !== null) {
    if (chg <= -3) score += 10;
    else if (chg <= -2) score += 8;
    else if (chg <= -1) score += 6;
    else if (chg < 0) score += 3;
  }

  const rsi = input.rsi14;
  if (rsi !== null) {
    if (rsi <= 20) score += 2;
    else if (rsi <= 30) score += 5;
    else if (rsi <= 55) score += 7;
    else if (rsi <= 70) score += Math.max(0, 7 - ((rsi - 55) / 15) * 5);
  }

  if (sp !== null && sp > 20) score -= 10;
  if (ann !== null && ann > 150) score -= 10;
  if (pos !== null && pos <= 15) score -= 10;
  if (input.gate0 === "BLOCK") return 0;
  return Math.round(Math.max(0, Math.min(100, score)));
}

function decisionReason(
  rule6: ScreenerCandidate["rule6"],
  ivRank: number | null,
  strike: number,
  maxPain: number | null,
  spreadPct: number | null,
  gate0: ScreenerCandidate["gate0"]
) {
  if (gate0 === "BLOCK") return "Blocked: position size exceeds CSP capacity.";
  if (rule6 === "GREEN") return "Blocked: stock is green today.";
  if (rule6 === "UNKNOWN") return "Watch: quote unverified - verify Rule 6.";
  const parts = ["Red day"];
  if (ivRank !== null && ivRank >= 50) parts.push("high IVR");
  if (maxPain !== null && strike < maxPain * 0.95) parts.push("strike below max pain");
  else if (maxPain !== null && strike >= maxPain) parts.push("strike at/above max pain");
  if (spreadPct !== null && spreadPct > 10) parts.push("wide spread");
  return `${parts.join(" + ")}.`;
}

function Metric({
  icon,
  label,
  value,
  tone = "neutral"
}: {
  icon?: React.ReactNode;
  label: string;
  value: string;
  tone?: "neutral" | "success" | "danger";
}) {
  const toneClass = tone === "success" ? "text-success" : tone === "danger" ? "text-danger" : "text-ink";
  return (
    <div className="rounded-lg border border-line bg-panel p-4 shadow-soft">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase text-muted">
        {icon}
        {label}
      </div>
      <div className={`mt-3 text-2xl font-semibold tabular ${toneClass}`}>{value}</div>
    </div>
  );
}

function StatusPill({
  children,
  tone
}: {
  children: React.ReactNode;
  tone: "success" | "warning" | "danger" | "neutral";
}) {
  const classes = {
    success: "bg-green-50 text-success ring-green-200",
    warning: "bg-amber-50 text-warning ring-amber-200",
    danger: "bg-red-50 text-danger ring-red-200",
    neutral: "bg-slate-50 text-muted ring-slate-200"
  };
  return (
    <span className={`inline-flex rounded-md px-2 py-1 text-xs font-semibold ring-1 ${classes[tone]}`}>{children}</span>
  );
}
