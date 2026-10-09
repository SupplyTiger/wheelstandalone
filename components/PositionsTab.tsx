"use client";

import { useEffect, useState } from "react";

type Position = {
  symbol: string;
  name: string;
  kind: string; // stock | call | put | option | cash | other
  quantity: number;
  side: "long" | "short";
  strike?: number;
  expiry?: string;
  option?: { root: string | null; expiry: string; right: string; strike: number } | null;
  cost_basis: number | null;
  market_value: number | null;
  unrealized: number | null;
};

type Snapshot = {
  ok: boolean;
  as_of: string;
  source: string;
  reason?: string;
  action_needed?: string;
  institution?: string;
  account_name?: string;
  account_mask?: string;
  price_as_of?: string | null;
  account_summary?: { equity: number; position_count: number } | null;
  positions: Position[];
  notes?: string[];
};

const money = (n: number | null | undefined) =>
  n == null
    ? "—"
    : n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

function freshness(asOf: string): { label: string; cls: string } {
  const ageH = (Date.now() - new Date(asOf).getTime()) / 3_600_000;
  if (ageH < 26) return { label: "Fresh", cls: "status-ready" };
  if (ageH < 24 * 7) return { label: "Stale", cls: "status-watch" };
  return { label: "Very stale", cls: "status-avoid" };
}

function kindLabel(p: Position): string {
  if (p.kind === "stock") return "Shares";
  if (p.kind === "call") return p.side === "short" ? "Short call" : "Long call";
  if (p.kind === "put") return p.side === "short" ? "Short put" : "Long put";
  if (p.kind === "cash") return "Cash";
  return p.kind;
}

function contractLabel(p: Position): string {
  const opt = p.option;
  if (!opt) return "—";
  return `$${opt.strike} ${opt.right === "call" ? "C" : "P"} · ${opt.expiry}`;
}

export function PositionsTab() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/positions-live.json", { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setSnap)
      .catch((e) => setError(e.message));
  }, []);

  if (error || (snap && !snap.ok && !snap.positions.length && snap.reason)) {
    // Honest state: never synced, or the feed is reporting a problem.
    return (
      <div className="panel placeholder-panel">
        <h2>Positions</h2>
        <p className="placeholder-body">
          {snap?.reason ||
            (error
              ? `No position snapshot on the server yet (${error}).`
              : "No position snapshot on the server yet.")}
        </p>
        <p className="placeholder-note">
          {snap?.action_needed ||
            "Run scripts/refresh-positions.mjs on the machine with the Plaid connection, then redeploy. No fabricated numbers here."}
        </p>
      </div>
    );
  }

  if (!snap) {
    return (
      <div className="panel">
        <div className="empty-state">Loading positions…</div>
      </div>
    );
  }

  const fresh = freshness(snap.as_of);
  const rows = snap.positions.filter((p) => p.kind !== "cash");
  const totalPnl = rows.reduce((s, p) => s + (p.unrealized || 0), 0);

  return (
    <div>
      <div className="tab-meta-bar">
        <h2 className="tab-meta-title">Positions</h2>
        <div className="meta">
          {snap.institution}
          {snap.account_mask ? ` ····${snap.account_mask}` : ""} · as of{" "}
          {new Date(snap.as_of).toLocaleString()} ·{" "}
          <span className={`status-pill ${fresh.cls}`}>{fresh.label}</span>
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <h2>Account</h2>
        <div className="scanner-counts">
          <span>Equity {money(snap.account_summary?.equity)}</span>
          <span>Open positions {snap.account_summary?.position_count}</span>
          <span className={totalPnl >= 0 ? "divergence-bullish" : "divergence-bearish"}>
            Unrealized {money(totalPnl)}
          </span>
        </div>
        {snap.price_as_of && (
          <div className="hint" style={{ marginTop: 8 }}>
            Prices as of {new Date(snap.price_as_of).toLocaleString()} (broker-reported, may lag
            the live market).
          </div>
        )}
      </div>

      <div className="panel">
        <h2>Open positions</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Type</th>
                <th>Qty</th>
                <th>Contract</th>
                <th>Cost basis</th>
                <th>Market value</th>
                <th>Unrealized</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p, i) => (
                <tr key={`${p.symbol}-${p.kind}-${i}`}>
                  <td>
                    <strong>{p.symbol}</strong>
                  </td>
                  <td>{kindLabel(p)}</td>
                  <td>
                    {p.side === "short" ? "−" : ""}
                    {Math.abs(p.quantity)}
                  </td>
                  <td>{contractLabel(p)}</td>
                  <td>{money(p.cost_basis)}</td>
                  <td>{money(p.market_value)}</td>
                  <td className={p.unrealized == null ? "" : p.unrealized >= 0 ? "day-up" : "day-down"}>
                    {p.unrealized == null ? "—" : money(p.unrealized)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {snap.notes?.map((n, i) => (
          <div className="hint" key={i} style={{ marginTop: 8 }}>
            {n}
          </div>
        ))}
      </div>
    </div>
  );
}
