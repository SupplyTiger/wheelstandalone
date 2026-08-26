"use client";

import { useState } from "react";
import { Activity, BriefcaseBusiness, Search, Target, TrendingUp } from "lucide-react";
import { ScreenerTab } from "../components/ScreenerTab";
import { PlaceholderTab } from "../components/PlaceholderTab";

type TabId = "portfolio" | "action" | "screener" | "positions" | "activity";

// Same 5 tabs as the original dashboard (Portfolio, Action Center, Screener, Positions,
// Activity). Screener is the only one rebuilt on the new TypeScript/yahoo-finance2 stack so
// far - the rest stay visible (per "work on one tab at a time, leave the others until we
// update them") but render an honest placeholder instead of the old Postgres/SnapTrade-backed
// version, since that backend isn't part of this rebuild and isn't configured here.
const TABS: Array<{ id: TabId; label: string; icon: React.ReactNode }> = [
  { id: "portfolio", label: "Portfolio", icon: <TrendingUp size={16} /> },
  { id: "action", label: "Action Center", icon: <Target size={16} /> },
  { id: "screener", label: "Screener", icon: <Search size={16} /> },
  { id: "positions", label: "Positions", icon: <BriefcaseBusiness size={16} /> },
  { id: "activity", label: "Activity", icon: <Activity size={16} /> },
];

const PLACEHOLDER_COPY: Record<Exclude<TabId, "screener">, string> = {
  portfolio: "Account value, open P&L vs. the $200K floor, and stock/options/cash allocation - pulled live once this tab is rebuilt.",
  action: "The 21 DTE Gamma Guard queue and other flagged positions that need a roll, close, or assignment decision this week.",
  positions: "Every open position synced from Fidelity - shares, short puts/calls, cost basis, and current gain/loss.",
  activity: "Session log of scans run, syncs, and broker connection status.",
};

export default function Home() {
  const [activeTab, setActiveTab] = useState<TabId>("screener");

  return (
    <main className="dash-shell">
      <header className="dash-header">
        <div>
          <div className="eyebrow">The Wheel</div>
          <h1>Investing Dashboard</h1>
        </div>
        <nav className="tab-nav">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`tab-nav-btn ${activeTab === tab.id ? "active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </nav>
      </header>

      <div className="dash-content">
        {activeTab === "screener" ? (
          <ScreenerTab />
        ) : (
          <PlaceholderTab
            title={TABS.find((t) => t.id === activeTab)!.label}
            icon={TABS.find((t) => t.id === activeTab)!.icon}
            description={PLACEHOLDER_COPY[activeTab]}
          />
        )}
      </div>
    </main>
  );
}
