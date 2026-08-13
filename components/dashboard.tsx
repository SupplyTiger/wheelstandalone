"use client";

import { useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  BriefcaseBusiness,
  CalendarDays,
  CircleDollarSign,
  Gauge,
  Link2,
  LogOut,
  ListFilter,
  RefreshCw,
  Search,
  ShieldCheck,
  Target,
  TrendingUp,
  WalletCards,
  X
} from "lucide-react";
import { AuthCard } from "@/components/auth-card";
import type { AccountSnapshot, CorporateEvents, OptionContract, ScreenerCandidate, WheelPosition } from "@/lib/types";
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

type TabId = "portfolio" | "action" | "screener" | "positions" | "activity";
type ChartRange = "day" | "month" | "year" | "overall";
type ActionRecommendation = "Hold" | "Close" | "Roll" | "Accept Assignment" | "Sell Covered Call";
type ActionItem = {
  position: WheelPosition;
  reason: string;
  recommendation: ActionRecommendation;
  severity: "high" | "medium" | "low";
  detail: string;
};

export function Dashboard({ userEmail, account, positions, watchlist, isConfigured, missingSnapTradeEnv = [] }: DashboardProps) {
  const [activeTab, setActiveTab] = useState<TabId>("portfolio");
  const [chartRange, setChartRange] = useState<ChartRange>("day");
  const [showPerformanceAlert, setShowPerformanceAlert] = useState(true);
  const [tickers, setTickers] = useState(watchlist.join(", "));
  const [candidates, setCandidates] = useState<ScreenerCandidate[]>([]);
  const [status, setStatus] = useState("");
  const [isScanning, setIsScanning] = useState(false);
  const [dteMin, setDteMin] = useState(7);
  const [dteMax, setDteMax] = useState(60);
  const [minRoi, setMinRoi] = useState(1);
  const [excludeEarnings, setExcludeEarnings] = useState(true);
  const [earningsWindow, setEarningsWindow] = useState(14);
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
  const performanceLeaders = useMemo(() => {
    const ranked = positions
      .map((position) => ({ position, score: performanceScore(position) }))
      .filter((row) => row.score !== null)
      .sort((a, b) => Number(a.score) - Number(b.score));

    return {
      worst: ranked[0]?.position ?? null,
      best: ranked[ranked.length - 1]?.position ?? null
    };
  }, [positions]);
  const atRisk = useMemo(
    () => positions.filter((pos) => pos.kind !== "stock" && pos.expiry && dteFromExpiry(pos.expiry) <= 7).length,
    [positions]
  );
  const floorGap = account.accountValue - account.floor;
  const scanProgressPct = scanStatus.total ? Math.round((scanStatus.completed / scanStatus.total) * 100) : 0;
  const topPositions = useMemo(
    () =>
      [...positions]
        .sort((a, b) => Math.abs(b.currentValue ?? b.price ?? 0) - Math.abs(a.currentValue ?? a.price ?? 0))
        .slice(0, 6),
    [positions]
  );
  const candidateStats = useMemo(
    () => ({
      ready: candidates.filter((row) => row.laneStatus === "ALERT_READY").length,
      watch: candidates.filter((row) => row.laneStatus === "WATCH").length,
      avoided: candidates.filter((row) => row.laneStatus === "AVOID").length,
      avgScore: candidates.length ? candidates.reduce((sum, row) => sum + row.score, 0) / candidates.length : 0
    }),
    [candidates]
  );
  const allocation = useMemo(() => {
    const cash = Math.max(0, account.cash ?? account.cashSecuredPutCapacity ?? 0);
    const stocks = positions
      .filter((pos) => pos.kind === "stock")
      .reduce((sum, pos) => sum + Math.abs(pos.currentValue ?? pos.price * Math.abs(pos.quantity)), 0);
    const options = positions
      .filter((pos) => pos.kind !== "stock")
      .reduce((sum, pos) => sum + Math.abs(pos.currentValue ?? pos.price * Math.abs(pos.quantity) * 100), 0);
    const total = Math.max(cash + stocks + options, account.accountValue, 1);
    return [
      { label: "Stocks", value: stocks, pct: (stocks / total) * 100, color: "#0f7b55" },
      { label: "Options", value: options, pct: (options / total) * 100, color: "#2864b4" },
      { label: "Cash", value: cash, pct: (cash / total) * 100, color: "#8a5207" }
    ];
  }, [account.accountValue, account.cash, account.cashSecuredPutCapacity, positions]);
  const actionItems = useMemo(() => buildActionItems(positions), [positions]);

  if (!userEmail) {
    return <AuthCard configured={isConfigured} />;
  }

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

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.reload();
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
          const corporateEvents = (data.corporateEvents ?? null) as CorporateEvents | null;
          const price = typeof quote.price === "number" ? quote.price : null;
          const options = data.options as OptionContract[];
          const maxPain = typeof data.maxPain === "number" ? data.maxPain : null;
          if (!price || price <= 0) throw new Error("Market data failed: invalid price");
          if (maxPain === null) throw new Error("Max pain calc failed: no OI data");

          const puts = options.filter((option) => option.kind === "put" && option.strike < price);
          const putStrikes = Array.from(new Set(puts.map((option) => option.strike))).sort((a, b) => a - b);
          if (!putStrikes.length) throw new Error("No OTM put strikes");
          const targetStrike = putStrikes.reduce((best, strike) =>
            Math.abs(strike - maxPain * 0.95) < Math.abs(best - maxPain * 0.95) ? strike : best
          );
          const liveContracts = puts
            .filter((option) => Math.abs(option.strike - targetStrike) <= 0.01)
            .filter((option) => option.bid !== null && option.ask !== null)
            .filter((option) => Number(option.bid) > 0 && Number(option.ask) > 0 && Number(option.bid) <= Number(option.ask))
            .sort((a, b) => Number(b.bid ?? 0) - Number(a.bid ?? 0));
          const put = liveContracts[0];
          if (!put) throw new Error("No live two-sided bid at target strike");

          const strike = put.strike;
          const bid = Number(put.bid);
          const ask = Number(put.ask);
          const mid = (bid + ask) / 2;
          const spreadPct = mid > 0 ? ((ask - bid) / mid) * 100 : null;
          const dte = dteFromExpiry(put.expiry);
          const calendarWarnings = corporateWarnings(corporateEvents, dte, earningsWindow);
          if (excludeEarnings && corporateEvents?.earningsDte !== null && corporateEvents?.earningsDte !== undefined) {
            if (corporateEvents.earningsDte >= 0 && corporateEvents.earningsDte <= earningsWindow) {
              throw new Error(`Earnings in ${corporateEvents.earningsDte} days; excluded by filter.`);
            }
          }
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
            decisionReason: decisionReason(rule6, ivRank, strike, maxPain, spreadPct, gate0, calendarWarnings),
            earningsDate: corporateEvents?.earningsDate ?? null,
            earningsDte: corporateEvents?.earningsDte ?? null,
            exDividendDate: corporateEvents?.exDividendDate ?? null,
            exDividendDte: corporateEvents?.exDividendDte ?? null,
            calendarWarnings
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
            decisionReason: error instanceof Error ? error.message : "Scan failed",
            earningsDate: null,
            earningsDte: null,
            exDividendDate: null,
            exDividendDte: null,
            calendarWarnings: []
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

  const tabs: Array<{ id: TabId; label: string; icon: React.ReactNode }> = [
    { id: "portfolio", label: "Portfolio", icon: <TrendingUp size={16} /> },
    { id: "action", label: "Action Center", icon: <Target size={16} /> },
    { id: "screener", label: "Screener", icon: <Search size={16} /> },
    { id: "positions", label: "Positions", icon: <BriefcaseBusiness size={16} /> },
    { id: "activity", label: "Activity", icon: <Activity size={16} /> }
  ];

  return (
    <main className="min-h-screen bg-[#f7f8f3] text-ink">
      {showPerformanceAlert ? (
        <PerformanceAlert best={performanceLeaders.best} worst={performanceLeaders.worst} onClose={() => setShowPerformanceAlert(false)} />
      ) : null}

      <header className="sticky top-0 z-10 border-b border-[#dfe4dc] bg-[#fbfcf7]/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#0f7b55]">The Wheel</p>
              <h1 className="text-xl font-semibold text-[#111811] sm:text-2xl">Investing Dashboard</h1>
            </div>
            <div className="flex lg:hidden">
              <AccountBadge source={account.source} syncedAt={account.syncedAt} />
            </div>
          </div>

          <nav className="flex gap-1 overflow-x-auto rounded-full border border-[#dfe4dc] bg-white p-1 shadow-soft">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`inline-flex h-9 shrink-0 items-center gap-2 rounded-full px-4 text-sm font-semibold transition ${
                  activeTab === tab.id ? "bg-[#111811] text-white" : "text-[#465148] hover:bg-[#eef3ea]"
                }`}
              >
                {tab.icon}
                {tab.label}
              </button>
            ))}
          </nav>

          <div className="hidden lg:flex">
            <AccountBadge source={account.source} syncedAt={account.syncedAt} />
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-4 py-5 sm:px-6">
        {status ? (
          <div className="mb-4 rounded-md border border-[#dfe4dc] bg-white px-4 py-3 text-sm text-[#465148] shadow-soft">
            {status}
          </div>
        ) : null}

        {activeTab === "portfolio" ? (
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
            <section className="rounded-lg border border-[#dfe4dc] bg-white p-5 shadow-soft">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <div className="flex items-center gap-2 text-sm font-semibold text-[#667163]">
                    <WalletCards size={18} />
                    Portfolio Value
                  </div>
                  <div className="mt-3 text-4xl font-semibold tracking-normal text-[#111811] tabular sm:text-5xl">
                    {fmtUsd(account.accountValue)}
                  </div>
                  <div className={`mt-2 text-sm font-semibold tabular ${totalGain >= 0 ? "text-[#0f7b55]" : "text-danger"}`}>
                    {fmtUsd(totalGain, true)} open P&L
                  </div>
                </div>
                <StatusPill tone={floorGap >= 0 ? "success" : "danger"}>
                  Floor {floorGap >= 0 ? "Protected" : "Breached"}
                </StatusPill>
              </div>
              <AccountChart value={account.accountValue} gain={totalGain} range={chartRange} onRangeChange={setChartRange} />
              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                <MetricCompact label="Buying Power" value={fmtUsd(account.buyingPower ?? null)} />
                <MetricCompact label="CSP Capacity" value={fmtUsd(account.cashSecuredPutCapacity ?? null)} />
                <MetricCompact label="Floor Cushion" value={fmtUsd(floorGap, true)} tone={floorGap >= 0 ? "success" : "danger"} />
              </div>
            </section>

            <aside className="space-y-4">
              <section className="rounded-lg border border-[#dfe4dc] bg-white p-4 shadow-soft">
                <div className="flex items-center justify-between">
                  <h2 className="font-semibold">Allocation</h2>
                  <BarChart3 size={18} className="text-[#667163]" />
                </div>
                <AllocationBars rows={allocation} />
              </section>

              <section className="rounded-lg border border-[#dfe4dc] bg-white p-4 shadow-soft">
                <div className="flex items-center justify-between">
                  <h2 className="font-semibold">Today</h2>
                  <Gauge size={18} className="text-[#667163]" />
                </div>
                <div className="mt-4 grid grid-cols-2 gap-3">
                  <MetricCompact label="Positions" value={String(positions.length)} />
                  <MetricCompact label="Review" value={String(atRisk)} tone={atRisk ? "danger" : "success"} />
                  <MetricCompact label="Actions" value={String(actionItems.length)} tone={actionItems.length ? "danger" : "success"} />
                  <MetricCompact label="Candidates" value={String(candidateStats.ready)} tone="success" />
                </div>
              </section>
            </aside>

            <section className="rounded-lg border border-[#dfe4dc] bg-white shadow-soft xl:col-span-2">
              <SectionHeader title="Largest Holdings" icon={<BriefcaseBusiness size={18} />} />
              <PositionList positions={topPositions} emptyText="No positions synced yet." />
            </section>
          </div>
        ) : null}

        {activeTab === "action" ? (
          <ActionCenter items={actionItems} positions={positions} />
        ) : null}

        {activeTab === "screener" ? (
          <div className="grid gap-4 xl:grid-cols-[340px_minmax(0,1fr)]">
            <aside className="rounded-lg border border-[#dfe4dc] bg-white p-4 shadow-soft">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold">CSP Screener</h2>
                <ListFilter size={18} className="text-[#667163]" />
              </div>
              <label className="mt-4 block text-xs font-semibold uppercase text-[#667163]" htmlFor="watchlist">
                Watchlist
              </label>
              <textarea
                id="watchlist"
                className="mt-2 min-h-32 w-full resize-y rounded-md border border-[#dfe4dc] bg-[#fbfcf7] p-3 text-sm outline-none focus:border-[#0f7b55]"
                value={tickers}
                onChange={(event) => setTickers(event.target.value)}
              />
              <div className="mt-3 grid grid-cols-3 gap-2">
                <NumberField id="dte-min" label="DTE Min" value={dteMin} onChange={setDteMin} min={1} />
                <NumberField id="dte-max" label="DTE Max" value={dteMax} onChange={setDteMax} min={1} />
                <NumberField id="min-roi" label="Min ROI" value={minRoi} onChange={setMinRoi} min={0} step={0.1} />
              </div>
              <div className="mt-3 rounded-md border border-[#dfe4dc] bg-[#fbfcf7] p-3">
                <label className="flex items-center gap-2 text-sm font-semibold text-[#111811]">
                  <input
                    type="checkbox"
                    checked={excludeEarnings}
                    onChange={(event) => setExcludeEarnings(event.target.checked)}
                    className="h-4 w-4 accent-[#0f7b55]"
                  />
                  Exclude earnings within
                </label>
                <div className="mt-2 grid grid-cols-[90px_1fr] items-center gap-2">
                  <NumberField id="earnings-window" label="Days" value={earningsWindow} onChange={setEarningsWindow} min={1} />
                  <p className="text-xs text-[#667163]">
                    Also flags ex-dividend dates and covered-call early-assignment risk.
                  </p>
                </div>
              </div>
              <button
                onClick={runScan}
                disabled={isScanning}
                className="mt-4 inline-flex h-10 w-full items-center justify-center gap-2 rounded-full bg-[#111811] px-4 text-sm font-semibold text-white disabled:opacity-60"
              >
                <Search size={16} />
                {isScanning ? "Scanning" : "Run Screener"}
              </button>

              <ScanProgress progress={scanStatus} percent={scanProgressPct} isScanning={isScanning} />
              <CalendarGuardrail excludeEarnings={excludeEarnings} earningsWindow={earningsWindow} />
            </aside>

            <section className="rounded-lg border border-[#dfe4dc] bg-white shadow-soft">
              <SectionHeader
                title="Candidates"
                icon={<CircleDollarSign size={18} />}
                meta={`${candidateStats.ready} ready / ${candidateStats.watch} watch / ${candidateStats.avoided} avoid`}
              />
              <CandidateTable candidates={candidates} />
            </section>
          </div>
        ) : null}

        {activeTab === "positions" ? (
          <section className="rounded-lg border border-[#dfe4dc] bg-white shadow-soft">
            <SectionHeader title="Positions" icon={<BriefcaseBusiness size={18} />} meta={`${positions.length} synced`} />
            <PositionsTable positions={positions} />
          </section>
        ) : null}

        {activeTab === "activity" ? (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
            <section className="rounded-lg border border-[#dfe4dc] bg-white p-5 shadow-soft">
              <SectionTitle icon={<Activity size={18} />} title="Session" />
              <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <MetricCompact label="Source" value={account.source ?? "Not connected"} />
                <MetricCompact label="Last Sync" value={account.syncedAt ? new Date(account.syncedAt).toLocaleString() : "-"} />
                <MetricCompact label="Scan Progress" value={scanStatus.total ? `${scanStatus.completed}/${scanStatus.total}` : "-"} />
                <MetricCompact label="Avg Score" value={candidates.length ? candidateStats.avgScore.toFixed(0) : "-"} />
              </div>
              <div className="mt-5 rounded-md border border-[#dfe4dc] bg-[#fbfcf7] p-4 text-sm text-[#465148]">
                {scanStatus.lastMessage || "No scanner activity yet."}
              </div>
            </section>

            <aside className="rounded-lg border border-[#dfe4dc] bg-white p-4 shadow-soft">
              <SectionTitle icon={<ShieldCheck size={18} />} title="Broker Link" />
              <div className="mt-4 space-y-2">
                <div className="rounded-md border border-[#dfe4dc] bg-[#fbfcf7] p-3 text-sm text-[#465148]">
                  Signed in as <span className="font-semibold text-[#111811]">{userEmail}</span>
                </div>
                <button
                  className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-full border border-[#dfe4dc] bg-white px-4 text-sm font-semibold text-[#111811]"
                  onClick={connectSnapTrade}
                  disabled={Boolean(missingSnapTradeEnv.length)}
                >
                  <Link2 size={16} />
                  Connect
                </button>
                <button
                  className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-full bg-[#0f7b55] px-4 text-sm font-semibold text-white"
                  onClick={syncSnapTrade}
                  disabled={Boolean(missingSnapTradeEnv.length)}
                >
                  <RefreshCw size={16} />
                  Sync
                </button>
                <button
                  className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-full border border-[#dfe4dc] bg-white px-4 text-sm font-semibold text-[#465148]"
                  onClick={logout}
                >
                  <LogOut size={16} />
                  Sign out
                </button>
              </div>
              {missingSnapTradeEnv.length ? (
                <p className="mt-3 rounded-md bg-amber-50 p-3 text-sm text-warning">
                  SnapTrade needs: {missingSnapTradeEnv.join(", ")}
                </p>
              ) : (
                <p className="mt-3 rounded-md bg-[#eef3ea] p-3 text-sm text-[#465148]">
                  Broker actions are manual while credentials are pending review.
                </p>
              )}
            </aside>
          </div>
        ) : null}
      </div>
    </main>
  );
}

function AccountChart({
  value,
  gain,
  range,
  onRangeChange
}: {
  value: number;
  gain: number;
  range: ChartRange;
  onRangeChange: (range: ChartRange) => void;
}) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const base = value > 0 ? value : 25000;
  const now = new Date();
  const rangeOptions: Array<{ id: ChartRange; label: string }> = [
    { id: "day", label: "Day" },
    { id: "month", label: "Month" },
    { id: "year", label: "Year" },
    { id: "overall", label: "Overall" }
  ];
  const rangeMeta: Record<ChartRange, { title: string; labels: string[]; driftFactor: number; waveFactor: number; points: number }> = {
    day: {
      title: "Today",
      labels: ["9:30 AM", "11:00 AM", "12:30 PM", "2:00 PM", "4:00 PM"],
      driftFactor: 0.0018,
      waveFactor: 0.012,
      points: 28
    },
    month: {
      title: "1 Month",
      labels: ["Week 1", "Week 2", "Week 3", "Week 4", "Today"],
      driftFactor: 0.006,
      waveFactor: 0.018,
      points: 31
    },
    year: {
      title: "1 Year",
      labels: ["Jul", "Oct", "Jan", "Apr", "Jul"],
      driftFactor: 0.018,
      waveFactor: 0.032,
      points: 52
    },
    overall: {
      title: "Overall",
      labels: ["Start", "Year 1", "Year 2", "Year 3", "Now"],
      driftFactor: 0.032,
      waveFactor: 0.045,
      points: 64
    }
  };
  const selectedRange = rangeMeta[range];
  const timeLabels = selectedRange.labels;
  const gradientId = `chartFill-${range}`;
  const updatedLabel = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const points = Array.from({ length: selectedRange.points }, (_, index) => {
    const progress = index / Math.max(1, selectedRange.points - 1);
    const drift = gain ? gain * progress : base * selectedRange.driftFactor * index;
    const wave =
      Math.sin(index / 2.2) * base * selectedRange.waveFactor +
      Math.cos(index / 4.8) * base * selectedRange.waveFactor * 0.5;
    return base - (gain || base * selectedRange.driftFactor * selectedRange.points * 0.6) + drift + wave;
  });
  const pointDates = points.map((_, index) => chartPointLabel(range, index, points.length, now));
  const min = Math.min(...points);
  const max = Math.max(...points);
  const width = 760;
  const height = 260;
  const plotLeft = 44;
  const plotRight = width - 34;
  const plotWidth = plotRight - plotLeft;
  const chartBottom = height - 34;
  const path = points
    .map((point, index) => {
      const x = plotLeft + (index / (points.length - 1)) * plotWidth;
      const y = chartBottom - ((point - min) / Math.max(1, max - min)) * (chartBottom - 18);
      return `${index === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
  const hoverPoint = hoverIndex === null ? null : points[hoverIndex];
  const hoverX = hoverIndex === null ? null : plotLeft + (hoverIndex / (points.length - 1)) * plotWidth;
  const hoverY =
    hoverIndex === null || hoverPoint === null
      ? null
      : chartBottom - ((hoverPoint - min) / Math.max(1, max - min)) * (chartBottom - 18);

  function updateHover(clientX: number, currentTarget: SVGSVGElement) {
    const rect = currentTarget.getBoundingClientRect();
    const localX = ((clientX - rect.left) / rect.width) * width;
    const progress = Math.max(0, Math.min(1, (localX - plotLeft) / plotWidth));
    setHoverIndex(Math.round(progress * (points.length - 1)));
  }

  return (
    <div className="mt-6 rounded-md bg-[#fbfcf7] p-3">
      <div className="flex flex-col gap-3 px-1 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-xs font-semibold uppercase text-[#667163]">
          <span>{selectedRange.title}</span>
          <span className="ml-3">Updated {updatedLabel}</span>
        </div>
        <div className="inline-flex w-full rounded-full border border-[#dfe4dc] bg-white p-1 sm:w-auto">
          {rangeOptions.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => onRangeChange(option.id)}
              className={`h-8 flex-1 rounded-full px-3 text-xs font-semibold transition sm:flex-none ${
                range === option.id ? "bg-[#111811] text-white" : "text-[#465148] hover:bg-[#eef3ea]"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-2 h-[280px]">
        <svg
          key={range}
          viewBox={`0 0 ${width} ${height}`}
          className="h-full w-full overflow-hidden"
          role="img"
          aria-label={`Portfolio ${selectedRange.title} trend chart`}
          onMouseMove={(event) => updateHover(event.clientX, event.currentTarget)}
          onMouseLeave={() => setHoverIndex(null)}
        >
          <defs>
            <clipPath id={`chartClip-${range}`}>
              <rect x={plotLeft} y="0" width={plotWidth} height={chartBottom} />
            </clipPath>
            <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="#0f7b55" stopOpacity="0.22" />
              <stop offset="100%" stopColor="#0f7b55" stopOpacity="0" />
            </linearGradient>
          </defs>
          {[0, 1, 2, 3].map((line) => (
            <line key={line} x1={plotLeft} x2={plotRight} y1={50 + line * 52} y2={50 + line * 52} stroke="#e3e8df" />
          ))}
          {timeLabels.map((label, index) => {
            const x = plotLeft + (index / (timeLabels.length - 1)) * plotWidth;
            return (
              <g key={`${range}-${index}-${label}`}>
                <line x1={x} x2={x} y1="12" y2={chartBottom} stroke="#edf0e9" />
                <text
                  x={x}
                  y={height - 8}
                  fill="#667163"
                  fontSize="15"
                  fontWeight="600"
                  textAnchor={index === 0 ? "start" : index === timeLabels.length - 1 ? "end" : "middle"}
                >
                  {label}
                </text>
              </g>
            );
          })}
          <g clipPath={`url(#chartClip-${range})`}>
            <path d={`${path} L ${plotRight} ${chartBottom} L ${plotLeft} ${chartBottom} Z`} fill={`url(#${gradientId})`} />
            <path d={path} fill="none" stroke="#0f7b55" strokeLinecap="round" strokeLinejoin="round" strokeWidth="4" />
          </g>
          {hoverIndex !== null && hoverX !== null && hoverY !== null && hoverPoint !== null ? (
            <g pointerEvents="none">
              <line x1={hoverX} x2={hoverX} y1="12" y2={chartBottom} stroke="#111811" strokeDasharray="4 4" opacity="0.35" />
              <circle cx={hoverX} cy={hoverY} r="6" fill="#0f7b55" stroke="#ffffff" strokeWidth="3" />
              <g transform={`translate(${Math.min(Math.max(hoverX - 92, plotLeft), plotRight - 184)} ${Math.max(16, hoverY - 74)})`}>
                <rect width="184" height="58" rx="8" fill="#111811" opacity="0.96" />
                <text x="12" y="22" fill="#ffffff" fontSize="13" fontWeight="700">
                  {pointDates[hoverIndex]}
                </text>
                <text x="12" y="43" fill="#b9dfca" fontSize="16" fontWeight="800">
                  {fmtUsd(hoverPoint)}
                </text>
              </g>
            </g>
          ) : null}
        </svg>
      </div>
    </div>
  );
}

function chartPointLabel(range: ChartRange, index: number, total: number, now: Date) {
  const progress = index / Math.max(1, total - 1);
  const date = new Date(now);
  if (range === "day") {
    date.setHours(9, 30, 0, 0);
    date.setMinutes(date.getMinutes() + Math.round(progress * 390));
    return date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }
  if (range === "month") {
    date.setDate(now.getDate() - (total - 1 - index));
    return date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
  }
  if (range === "year") {
    date.setDate(now.getDate() - Math.round((1 - progress) * 365));
    return date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
  }
  date.setFullYear(now.getFullYear() - 3);
  date.setDate(date.getDate() + Math.round(progress * 365 * 3));
  return date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

function PerformanceAlert({
  best,
  worst,
  onClose
}: {
  best: WheelPosition | null;
  worst: WheelPosition | null;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#111811]/45 px-4 py-6 backdrop-blur-sm">
      <section className="w-full max-w-3xl rounded-lg border border-[#dfe4dc] bg-white p-4 shadow-[0_24px_80px_rgba(17,24,17,0.24)] sm:p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#667163]">Performance Alert</p>
            <h2 className="mt-1 text-2xl font-semibold text-[#111811]">Best vs worst performer</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[#dfe4dc] bg-white text-[#465148] hover:bg-[#eef3ea]"
            aria-label="Close performance alert"
          >
            <X size={18} />
          </button>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <PerformanceBox tone="danger" title="Worst Performance" position={worst} />
          <PerformanceBox tone="success" title="Best Performance" position={best} />
        </div>

        <button
          type="button"
          onClick={onClose}
          className="mt-5 inline-flex h-10 w-full items-center justify-center rounded-full bg-[#111811] px-4 text-sm font-semibold text-white sm:w-auto"
        >
          Continue to dashboard
        </button>
      </section>
    </div>
  );
}

function PerformanceBox({
  tone,
  title,
  position
}: {
  tone: "success" | "danger";
  title: string;
  position: WheelPosition | null;
}) {
  const toneClasses =
    tone === "success"
      ? "border-[#b9dfca] bg-[#e8f6ee] text-[#0f7b55]"
      : "border-red-200 bg-red-50 text-danger";
  const score = position ? performanceScore(position) : null;

  return (
    <div className={`rounded-lg border p-4 ${toneClasses}`}>
      <div className="text-xs font-semibold uppercase tracking-[0.14em] opacity-80">{title}</div>
      {position ? (
        <>
          <div className="mt-3 text-2xl font-semibold text-[#111811]">{position.ticker}</div>
          <div className="mt-1 text-sm text-[#465148]">{position.symbol ?? `${position.side ?? "long"} ${position.kind}`}</div>
          <div className="mt-4 text-3xl font-semibold tabular">
            {position.gainPct !== null && position.gainPct !== undefined ? fmtPct(position.gainPct, true) : fmtUsd(score, true)}
          </div>
          <div className="mt-1 text-sm font-semibold tabular text-[#465148]">
            {position.gainUsd !== null && position.gainUsd !== undefined ? `${fmtUsd(position.gainUsd, true)} P&L` : "P&L unavailable"}
          </div>
        </>
      ) : (
        <div className="mt-6 rounded-md bg-white/70 p-4 text-sm font-semibold text-[#465148]">
          No synced performance data yet.
        </div>
      )}
    </div>
  );
}

function AllocationBars({ rows }: { rows: Array<{ label: string; value: number; pct: number; color: string }> }) {
  return (
    <div className="mt-4 space-y-4">
      {rows.map((row) => (
        <div key={row.label}>
          <div className="flex items-center justify-between text-sm">
            <span className="font-semibold">{row.label}</span>
            <span className="text-[#667163] tabular">{fmtUsd(row.value)}</span>
          </div>
          <div className="mt-2 h-2 rounded-full bg-[#eef3ea]">
            <div className="h-2 rounded-full" style={{ width: `${Math.min(100, row.pct)}%`, backgroundColor: row.color }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function ScanProgress({ progress, percent, isScanning }: { progress: ScanStatus; percent: number; isScanning: boolean }) {
  if (!progress.total) return null;
  return (
    <div className="mt-4 rounded-md border border-[#dfe4dc] bg-[#fbfcf7] p-3">
      <div className="flex items-center justify-between gap-3 text-xs font-semibold uppercase text-[#667163]">
        <span>{isScanning ? `Scanning ${progress.currentTicker || "..."}` : "Scanner"}</span>
        <span className="tabular">
          {progress.completed}/{progress.total}
        </span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-white ring-1 ring-[#dfe4dc]">
        <div className="h-full rounded-full bg-[#0f7b55] transition-all" style={{ width: `${percent}%` }} />
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
        <ScanCount label="Found" value={progress.candidates} tone="success" />
        <ScanCount label="Blocked" value={progress.blocked} tone="warning" />
        <ScanCount label="Errors" value={progress.errors} tone="danger" />
      </div>
      <p className="mt-3 text-xs text-[#667163]">{progress.lastMessage}</p>
    </div>
  );
}

function CandidateTable({ candidates }: { candidates: ScreenerCandidate[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1280px] text-left text-sm">
        <thead className="border-b border-[#dfe4dc] bg-[#fbfcf7] text-xs uppercase text-[#667163]">
          <tr>
            <th className="px-4 py-3">Ticker</th>
            <th className="px-4 py-3 text-right">Score</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3 text-right">Price</th>
            <th className="px-4 py-3 text-right">Strike</th>
            <th className="px-4 py-3">Expiry</th>
            <th className="px-4 py-3 text-right">DTE</th>
            <th className="px-4 py-3 text-right">Bid</th>
            <th className="px-4 py-3 text-right">ROI</th>
            <th className="px-4 py-3 text-right">Ann ROI</th>
            <th className="px-4 py-3 text-right">Max Pain</th>
            <th className="px-4 py-3">Calendar</th>
            <th className="px-4 py-3">Reason</th>
          </tr>
        </thead>
        <tbody>
          {candidates.length ? (
            candidates.map((row) => {
              const rowTone = row.changePct !== null && row.changePct < 0 ? "loss" : "profit";
              return (
                <tr key={`${row.ticker}-${row.expiry}-${row.strike}`} className={`border-b border-[#edf0e9] last:border-0 ${tableRowTone(rowTone)}`}>
                  <td className="px-4 py-3 font-semibold">{row.ticker}</td>
                  <td className="px-4 py-3 text-right font-semibold tabular">{row.score.toFixed(0)}</td>
                  <td className="px-4 py-3">
                    <StatusPill tone={row.laneStatus === "ALERT_READY" ? "success" : row.laneStatus === "WATCH" ? "warning" : "neutral"}>
                      {row.laneStatus.replace("_", " ")}
                    </StatusPill>
                  </td>
                  <td className="px-4 py-3 text-right tabular">{fmtUsd(row.price)}</td>
                  <td className="px-4 py-3 text-right tabular">{fmtUsd(row.strike)}</td>
                  <td className="px-4 py-3">{row.expiry}</td>
                  <td className="px-4 py-3 text-right tabular">{row.dte}</td>
                  <td className="px-4 py-3 text-right tabular">{fmtUsd(row.bid)}</td>
                  <td className="px-4 py-3 text-right tabular">{fmtPct(row.roiPct)}</td>
                  <td className="px-4 py-3 text-right tabular">{fmtPct(row.annRoiPct)}</td>
                  <td className="px-4 py-3 text-right tabular">{fmtUsd(row.maxPain)}</td>
                  <td className="px-4 py-3">
                    <CalendarWarnings candidate={row} />
                  </td>
                  <td className="px-4 py-3 text-[#667163]">{row.decisionReason}</td>
                </tr>
              );
            })
          ) : (
            <tr>
              <td colSpan={13} className="px-4 py-16 text-center text-[#667163]">
                Run the screener to populate candidates.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function ActionCenter({ items, positions }: { items: ActionItem[]; positions: WheelPosition[] }) {
  const coveredCallCount = positions.filter((pos) => pos.kind === "stock" && Math.abs(pos.quantity) >= 100).length;
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
      <section className="rounded-lg border border-[#dfe4dc] bg-white shadow-soft">
        <SectionHeader title="Action Center" icon={<Target size={18} />} meta={`${items.length} need attention today`} />
        {items.length ? (
          <div className="divide-y divide-[#edf0e9]">
            {items.map((item) => (
              <div
                key={`${item.position.id ?? item.position.symbol}-${item.reason}-${item.recommendation}`}
                className={`grid gap-3 px-4 py-4 lg:grid-cols-[1fr_150px_170px] ${actionSeverityClass(item.severity)}`}
              >
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{item.position.symbol ?? item.position.ticker}</span>
                    <StatusPill tone={item.severity === "high" ? "danger" : item.severity === "medium" ? "warning" : "neutral"}>
                      {item.reason}
                    </StatusPill>
                  </div>
                  <p className="mt-2 text-sm text-[#465148]">{item.detail}</p>
                </div>
                <div className="text-sm">
                  <div className="text-xs font-semibold uppercase text-[#667163]">Recommendation</div>
                  <div className="mt-1 font-semibold text-[#111811]">{item.recommendation}</div>
                </div>
                <div className="text-sm tabular text-[#667163]">
                  <div>{item.position.expiry ? `${dteFromExpiry(item.position.expiry)} DTE` : "No expiry"}</div>
                  <div>{fmtUsd(item.position.gainUsd, true)} P&L</div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="px-4 py-16 text-center text-sm text-[#667163]">
            Nothing urgent today. Positions can stay in normal monitoring.
          </div>
        )}
      </section>

      <aside className="space-y-4">
        <section className="rounded-lg border border-[#dfe4dc] bg-white p-4 shadow-soft">
          <SectionTitle icon={<AlertTriangle size={18} />} title="Today Rules" />
          <div className="mt-4 space-y-3 text-sm text-[#465148]">
            <RuleLine label="Close" text="Short option profit target reached or quote is unreliable." />
            <RuleLine label="Roll" text="Expiry is close, strike is threatened, or assignment risk is rising." />
            <RuleLine label="Accept Assignment" text="Short put is breached and assignment fits the wheel plan." />
            <RuleLine label="Sell Covered Call" text="100+ shares with no active short call." />
            <RuleLine label="Hold" text="No urgent trigger, but continue watching." />
          </div>
        </section>
        <section className="rounded-lg border border-[#dfe4dc] bg-white p-4 shadow-soft">
          <SectionTitle icon={<BriefcaseBusiness size={18} />} title="Coverage" />
          <div className="mt-4 grid grid-cols-2 gap-3">
            <MetricCompact label="Synced" value={String(positions.length)} />
            <MetricCompact label="CC Ready" value={String(coveredCallCount)} tone={coveredCallCount ? "success" : "neutral"} />
          </div>
        </section>
      </aside>
    </div>
  );
}

function CalendarGuardrail({ excludeEarnings, earningsWindow }: { excludeEarnings: boolean; earningsWindow: number }) {
  return (
    <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3">
      <div className="flex items-center gap-2 text-sm font-semibold text-warning">
        <CalendarDays size={16} />
        Earnings / Ex-Dividend
      </div>
      <p className="mt-2 text-xs text-[#667163]">
        {excludeEarnings
          ? `CSP candidates with earnings inside ${earningsWindow} days are skipped when Yahoo calendar data is available.`
          : "Earnings are shown as warnings but not excluded."}
      </p>
    </div>
  );
}

function CalendarWarnings({ candidate }: { candidate: ScreenerCandidate }) {
  const warnings = candidate.calendarWarnings ?? [];
  if (!warnings.length) {
    return <span className="text-xs text-[#667163]">Clear</span>;
  }
  return (
    <div className="flex max-w-[220px] flex-wrap gap-1">
      {warnings.slice(0, 2).map((warning) => (
        <span key={warning} className="rounded-full bg-amber-50 px-2 py-1 text-xs font-semibold text-warning ring-1 ring-amber-200">
          {warning}
        </span>
      ))}
    </div>
  );
}

function RuleLine({ label, text }: { label: ActionRecommendation; text: string }) {
  return (
    <div>
      <span className="font-semibold text-[#111811]">{label}:</span> {text}
    </div>
  );
}

function PositionsTable({ positions }: { positions: WheelPosition[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[820px] text-left text-sm">
        <thead className="border-b border-[#dfe4dc] bg-[#fbfcf7] text-xs uppercase text-[#667163]">
          <tr>
            <th className="px-4 py-3">Symbol</th>
            <th className="px-4 py-3">Kind</th>
            <th className="px-4 py-3 text-right">Qty</th>
            <th className="px-4 py-3 text-right">Mark</th>
            <th className="px-4 py-3 text-right">Value</th>
            <th className="px-4 py-3 text-right">P&L</th>
            <th className="px-4 py-3">Expiry</th>
            <th className="px-4 py-3">Status</th>
          </tr>
        </thead>
        <tbody>
          {positions.length ? (
            positions.map((pos) => {
              const rowTone = (pos.gainUsd ?? 0) < 0 ? "loss" : "profit";
              return (
                <tr key={pos.id ?? `${pos.symbol}-${pos.expiry}`} className={`border-b border-[#edf0e9] last:border-0 ${tableRowTone(rowTone)}`}>
                  <td className="px-4 py-3 font-semibold">{pos.symbol ?? pos.ticker}</td>
                  <td className="px-4 py-3 capitalize text-[#667163]">{pos.kind}</td>
                  <td className="px-4 py-3 text-right tabular">{pos.quantity}</td>
                  <td className="px-4 py-3 text-right tabular">{fmtUsd(pos.price)}</td>
                  <td className="px-4 py-3 text-right tabular">{fmtUsd(pos.currentValue ?? null)}</td>
                  <td className={`px-4 py-3 text-right tabular ${(pos.gainUsd ?? 0) >= 0 ? "text-[#0f7b55]" : "text-danger"}`}>
                    {fmtUsd(pos.gainUsd, true)}
                  </td>
                  <td className="px-4 py-3 text-[#667163]">{pos.expiry ?? "-"}</td>
                  <td className="px-4 py-3">
                    <StatusPill tone={pos.expiry && dteFromExpiry(pos.expiry) <= 7 ? "danger" : "success"}>
                      {pos.expiry && dteFromExpiry(pos.expiry) <= 7 ? "Review" : "OK"}
                    </StatusPill>
                  </td>
                </tr>
              );
            })
          ) : (
            <tr>
              <td colSpan={8} className="px-4 py-16 text-center text-[#667163]">
                No positions synced yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function PositionList({ positions, emptyText }: { positions: WheelPosition[]; emptyText: string }) {
  if (!positions.length) return <div className="px-4 py-12 text-center text-sm text-[#667163]">{emptyText}</div>;
  return (
    <div className="divide-y divide-[#edf0e9]">
      {positions.map((pos) => (
        <div key={pos.id ?? `${pos.symbol}-${pos.expiry}`} className="grid grid-cols-[1fr_auto] items-center gap-3 px-4 py-3 sm:grid-cols-[1fr_120px_120px_110px]">
          <div>
            <div className="font-semibold">{pos.symbol ?? pos.ticker}</div>
            <div className="text-xs capitalize text-[#667163]">
              {pos.side ?? "long"} {pos.kind}
            </div>
          </div>
          <div className="hidden text-right text-sm tabular sm:block">{fmtUsd(pos.currentValue ?? null)}</div>
          <div className={`hidden text-right text-sm tabular sm:block ${(pos.gainUsd ?? 0) >= 0 ? "text-[#0f7b55]" : "text-danger"}`}>
            {fmtUsd(pos.gainUsd, true)}
          </div>
          <div className="justify-self-end">
            <StatusPill tone={pos.expiry && dteFromExpiry(pos.expiry) <= 7 ? "danger" : "success"}>
              {pos.expiry && dteFromExpiry(pos.expiry) <= 7 ? "Review" : "OK"}
            </StatusPill>
          </div>
        </div>
      ))}
    </div>
  );
}

function NumberField({
  id,
  label,
  value,
  onChange,
  min,
  step
}: {
  id: string;
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  step?: number;
}) {
  return (
    <label className="block text-xs font-semibold uppercase text-[#667163]" htmlFor={id}>
      {label}
      <input
        id={id}
        type="number"
        min={min}
        step={step}
        className="mt-1 h-9 w-full rounded-md border border-[#dfe4dc] bg-[#fbfcf7] px-2 text-sm font-normal text-ink outline-none focus:border-[#0f7b55]"
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function MetricCompact({
  label,
  value,
  tone = "neutral"
}: {
  label: string;
  value: string;
  tone?: "neutral" | "success" | "danger";
}) {
  const toneClass = tone === "success" ? "text-[#0f7b55]" : tone === "danger" ? "text-danger" : "text-[#111811]";
  return (
    <div className="rounded-md border border-[#dfe4dc] bg-[#fbfcf7] p-3">
      <div className="text-xs font-semibold uppercase text-[#667163]">{label}</div>
      <div className={`mt-2 text-lg font-semibold tabular ${toneClass}`}>{value}</div>
    </div>
  );
}

function ScanCount({ label, value, tone }: { label: string; value: number; tone: "success" | "warning" | "danger" }) {
  const toneClass = tone === "success" ? "text-[#0f7b55]" : tone === "warning" ? "text-warning" : "text-danger";
  return (
    <span className={`rounded bg-white px-2 py-1 ring-1 ring-[#dfe4dc] ${toneClass}`}>
      {label} <b className="tabular">{value}</b>
    </span>
  );
}

function SectionHeader({ title, icon, meta }: { title: string; icon: React.ReactNode; meta?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-[#dfe4dc] px-4 py-3">
      <SectionTitle title={title} icon={icon} />
      {meta ? <span className="text-sm text-[#667163]">{meta}</span> : null}
    </div>
  );
}

function SectionTitle({ title, icon }: { title: string; icon: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 font-semibold">
      <span className="text-[#0f7b55]">{icon}</span>
      {title}
    </div>
  );
}

function AccountBadge({ source, syncedAt }: { source?: string | null; syncedAt?: string | null }) {
  return (
    <div className="rounded-full border border-[#dfe4dc] bg-white px-3 py-2 text-xs font-semibold text-[#465148] shadow-soft">
      {source ?? "not connected"} {syncedAt ? `- ${new Date(syncedAt).toLocaleDateString()}` : ""}
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
    success: "bg-[#e8f6ee] text-[#0f7b55] ring-[#b9dfca]",
    warning: "bg-amber-50 text-warning ring-amber-200",
    danger: "bg-red-50 text-danger ring-red-200",
    neutral: "bg-slate-50 text-[#667163] ring-slate-200"
  };
  return (
    <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${classes[tone]}`}>
      {children}
    </span>
  );
}

function performanceScore(position: WheelPosition): number | null {
  if (typeof position.gainPct === "number" && Number.isFinite(position.gainPct)) return position.gainPct;
  if (typeof position.gainUsd === "number" && Number.isFinite(position.gainUsd)) return position.gainUsd;
  return null;
}

function tableRowTone(tone: "loss" | "profit") {
  return tone === "loss" ? "bg-red-50/55 hover:bg-red-50" : "bg-[#eef8f1]/70 hover:bg-[#e4f3e9]";
}

function actionSeverityClass(severity: ActionItem["severity"]) {
  if (severity === "high") return "bg-red-50/65";
  if (severity === "medium") return "bg-amber-50/70";
  return "bg-[#fbfcf7]";
}

function buildActionItems(positions: WheelPosition[]): ActionItem[] {
  const stockPriceByTicker = new Map(
    positions
      .filter((pos) => pos.kind === "stock" && typeof pos.price === "number")
      .map((pos) => [pos.ticker.toUpperCase(), pos.price])
  );
  const shortCallsByTicker = new Map<string, number>();
  positions
    .filter((pos) => pos.kind === "call" && pos.side === "short")
    .forEach((pos) => shortCallsByTicker.set(pos.ticker.toUpperCase(), (shortCallsByTicker.get(pos.ticker.toUpperCase()) ?? 0) + Math.abs(pos.quantity)));

  const items: ActionItem[] = [];
  for (const position of positions) {
    const dte = position.expiry ? dteFromExpiry(position.expiry) : null;
    const underlyingPrice = stockPriceByTicker.get(position.ticker.toUpperCase()) ?? null;
    const gainPct = position.gainPct ?? null;
    const isShortOption = position.kind !== "stock" && position.side === "short";

    if (position.kind === "stock") {
      const shares = Math.abs(position.quantity);
      if (shares >= 100 && !shortCallsByTicker.get(position.ticker.toUpperCase())) {
        items.push({
          position,
          reason: "Uncovered shares",
          recommendation: "Sell Covered Call",
          severity: "low",
          detail: `${position.ticker} has ${shares} shares and no synced short call. Review a green-day covered call setup.`
        });
      }
      continue;
    }

    if (position.price <= 0 || position.optionMarkVerified === false) {
      items.push({
        position,
        reason: "Missing quote",
        recommendation: "Close",
        severity: "medium",
        detail: "Quote or option mark is not verified. Confirm bid/ask before relying on P&L."
      });
    }

    if (isShortOption && gainPct !== null && gainPct >= 50) {
      items.push({
        position,
        reason: "Profit target",
        recommendation: "Close",
        severity: "medium",
        detail: `${fmtPct(gainPct)} of premium target appears captured. Consider closing to release risk.`
      });
    }

    if (dte !== null && dte <= 7) {
      items.push({
        position,
        reason: "Expiring soon",
        recommendation: isShortOption ? "Roll" : "Hold",
        severity: dte <= 2 ? "high" : "medium",
        detail: `${position.symbol ?? position.ticker} expires in ${dte} days. Decide before expiry week pins the trade.`
      });
    }

    if (position.kind === "put" && position.side === "short" && underlyingPrice !== null && position.strike !== null && position.strike !== undefined) {
      if (underlyingPrice <= position.strike) {
        items.push({
          position,
          reason: "Breached strike",
          recommendation: "Accept Assignment",
          severity: "high",
          detail: `${position.ticker} is at ${fmtUsd(underlyingPrice)} versus ${fmtUsd(position.strike)} strike. Prepare assignment plan or roll.`
        });
      } else if (underlyingPrice <= position.strike * 1.03) {
        items.push({
          position,
          reason: "Assignment risk",
          recommendation: "Roll",
          severity: "medium",
          detail: `${position.ticker} is within 3% of the short-put strike. Monitor delta, liquidity, and buying power.`
        });
      }
    }

    if (position.kind === "call" && position.side === "short" && underlyingPrice !== null && position.strike !== null && position.strike !== undefined) {
      if (underlyingPrice >= position.strike) {
        items.push({
          position,
          reason: "Breached strike",
          recommendation: "Roll",
          severity: "high",
          detail: `${position.ticker} is above the covered-call strike. Roll or accept called-away shares.`
        });
      } else if (underlyingPrice >= position.strike * 0.97) {
        items.push({
          position,
          reason: "Assignment risk",
          recommendation: "Roll",
          severity: "medium",
          detail: `${position.ticker} is within 3% of the covered-call strike. Check ex-dividend timing before holding.`
        });
      }
    }
  }

  return dedupeActionItems(items).sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
}

function dedupeActionItems(items: ActionItem[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.position.id ?? item.position.symbol}-${item.reason}-${item.recommendation}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function severityRank(severity: ActionItem["severity"]) {
  return severity === "high" ? 3 : severity === "medium" ? 2 : 1;
}

function corporateWarnings(events: CorporateEvents | null, optionDte: number, earningsWindow: number) {
  const warnings: string[] = [];
  if (!events) {
    warnings.push("Calendar unavailable");
    return warnings;
  }
  if (events.earningsDte !== null && events.earningsDte !== undefined && events.earningsDte >= 0) {
    if (events.earningsDte <= earningsWindow) warnings.push(`Earnings ${events.earningsDte}d`);
    else if (events.earningsDte <= optionDte) warnings.push("Earnings before expiry");
  }
  if (events.exDividendDte !== null && events.exDividendDte !== undefined && events.exDividendDte >= 0) {
    if (events.exDividendDte <= optionDte) warnings.push(`Ex-div ${events.exDividendDte}d`);
  }
  if (events.warning) warnings.push("Verify calendar");
  return warnings;
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
  gate0: ScreenerCandidate["gate0"],
  calendarWarnings: string[] = []
) {
  if (gate0 === "BLOCK") return "Blocked: position size exceeds CSP capacity.";
  if (rule6 === "GREEN") return "Blocked: stock is green today.";
  if (rule6 === "UNKNOWN") return "Watch: quote unverified - verify Rule 6.";
  const parts = ["Red day"];
  if (ivRank !== null && ivRank >= 50) parts.push("high IVR");
  if (maxPain !== null && strike < maxPain * 0.95) parts.push("strike below max pain");
  else if (maxPain !== null && strike >= maxPain) parts.push("strike at/above max pain");
  if (spreadPct !== null && spreadPct > 10) parts.push("wide spread");
  if (calendarWarnings.length) parts.push(calendarWarnings[0].toLowerCase());
  return `${parts.join(" + ")}.`;
}
