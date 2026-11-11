"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";

// Live Portfolio tab — reads GET /api/portfolio (SnapTrade → Fidelity, read-only).
// No fabricated numbers: if the route errors, the exact stage + SnapTrade message is shown.

const HARD_FLOOR = 200_000;
const GAMMA_GUARD_DTE = 21;

type Stock = {
  ticker: string;
  side: "long" | "short";
  quantity: number;
  price: number | null;
  avgCost: number | null;
  marketValue: number | null;
  gainUsd: number | null;
  gainPct: number | null;
};

type Option = {
  ticker: string;
  description: string;
  type: "put" | "call";
  side: "long" | "short";
  contracts: number;
  strike: number | null;
  expiry: string | null;
  dte: number | null;
  mark: number | null;
  avgPremium: number | null;
  marketValue: number | null;
  gainUsd: number | null;
  gainPct: number | null;
  markVerified: boolean;
};

type Account = {
  last4: string;
  name: string;
  institution: string | null;
  totalValue: number | null;
  lastHoldingsSync: string | null;
  balances: Array<{ currency: string; cash: number | null; buyingPower: number | null }>;
  stocks: Stock[];
  cashEquivalents: Stock[];
  options: Option[];
};

type PortfolioOk = {
  ok: boolean;
  partial: boolean;
  fetchedAt: string;
  totals: { accounts: number; totalValue: number; stockPositions: number; optionPositions: number; shortPuts: number; shortCalls: number };
  accounts: Account[];
  errors: string[];
};

type PortfolioErr = { ok: false; stage?: string; error?: string; hint?: string; snaptradeStatus?: number; env?: Record<string, boolean> };

const usd = (n: number | null | undefined, digits = 0) =>
  n === null || n === undefined
    ? "—"
    : n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });
const pct = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`);
const signClass = (n: number | null | undefined) => (n === null || n === undefined || n === 0 ? "day-flat" : n > 0 ? "day-up" : "day-down");

function accountCash(a: Account) {
  const bal = a.balances.reduce((s, b) => s + (b.cash ?? 0), 0);
  const mm = a.cashEquivalents.reduce((s, c) => s + (c.marketValue ?? 0), 0);
  return bal + mm;
}

export function PortfolioTab() {
  const [data, setData] = useState<PortfolioOk | null>(null);
  const [err, setErr] = useState<PortfolioErr | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch("/api/portfolio", { cache: "no-store" });
      const body = (await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))) as PortfolioOk | PortfolioErr;
      if (!res.ok || !("accounts" in body)) {
        setErr({ ...(body as PortfolioErr), error: (body as PortfolioErr).error ?? `HTTP ${res.status}` });
      } else {
        setData(body);
      }
    } catch (e) {
      setErr({ ok: false, error: e instanceof Error ? e.message : "Network error" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const summary = useMemo(() => {
    if (!data) return null;
    const cash = data.accounts.reduce((s, a) => s + accountCash(a), 0);
    const stocks = data.accounts.flatMap((a) => a.stocks);
    const options = data.accounts.flatMap((a) => a.options);
    const stockValue = stocks.reduce((s, p) => s + (p.marketValue ?? 0), 0);
    const openPnl =
      stocks.reduce((s, p) => s + (p.gainUsd ?? 0), 0) + options.reduce((s, o) => s + (o.gainUsd ?? 0), 0);
    const putCollateral = options
      .filter((o) => o.side === "short" && o.type === "put")
      .reduce((s, o) => s + (o.strike ?? 0) * o.contracts * 100, 0);
    const gammaGuard = options.filter((o) => o.side === "short" && o.dte !== null && o.dte <= GAMMA_GUARD_DTE);
    // Revenue Gap: 100+ long shares with no short call on the same ticker.
    const shortCallTickers = new Set(options.filter((o) => o.side === "short" && o.type === "call").map((o) => o.ticker));
    const uncovered = stocks.filter((s) => s.side === "long" && s.quantity >= 100 && !shortCallTickers.has(s.ticker));
    return { cash, stockValue, openPnl, putCollateral, gammaGuard, uncovered };
  }, [data]);

  const total = data?.totals.totalValue ?? null;
  const cushion = total !== null ? total - HARD_FLOOR : null;

  return (
    <div>
      <div className="tab-meta-bar">
        <h2 className="tab-meta-title">Portfolio</h2>
        <div className="meta">
          {data ? `Synced ${new Date(data.fetchedAt).toLocaleTimeString()} · SnapTrade → Fidelity (read-only)` : "SnapTrade → Fidelity (read-only)"}
          <button type="button" className="sort-reset" onClick={() => void load()} disabled={loading} style={{ marginLeft: 10 }}>
            <RefreshCw size={12} style={{ verticalAlign: "-2px" }} /> {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </div>

      {err && (
        <div className="error-banner">
          <strong>Portfolio sync failed{err.stage ? ` at ${err.stage}` : ""}{err.snaptradeStatus ? ` (SnapTrade HTTP ${err.snaptradeStatus})` : ""}:</strong> {err.error}
          {err.hint && <div style={{ marginTop: 4 }}>{err.hint}</div>}
          {err.env && (
            <div style={{ marginTop: 4 }}>
              Env: {Object.entries(err.env).map(([k, v]) => `${k} ${v ? "✓" : "✗ missing"}`).join(" · ")}
            </div>
          )}
        </div>
      )}

      {!data && !err && <div className="panel empty-state">Loading positions from Fidelity…</div>}

      {data && summary && (
        <>
          {data.partial && (
            <div className="error-banner" style={{ background: "var(--amber-bg)", color: "var(--amber)" }}>
              Partial sync — {data.errors.join(" · ")}
            </div>
          )}

          <div className="kpi-grid">
            <div className="panel kpi">
              <div className="kpi-label">Account value</div>
              <div className="kpi-value">{usd(total)}</div>
              <div className="kpi-sub">{data.totals.accounts} account{data.totals.accounts === 1 ? "" : "s"}</div>
            </div>
            <div className="panel kpi">
              <div className="kpi-label">vs $200K hard floor</div>
              <div className={`kpi-value ${signClass(cushion)}`}>{cushion === null ? "—" : `${cushion >= 0 ? "+" : ""}${usd(cushion)}`}</div>
              <div className="kpi-sub">{cushion !== null && cushion < 0 ? "BELOW FLOOR — preservation mode" : "cushion above floor"}</div>
            </div>
            <div className="panel kpi">
              <div className="kpi-label">Open P&amp;L</div>
              <div className={`kpi-value ${signClass(summary.openPnl)}`}>{usd(summary.openPnl)}</div>
              <div className="kpi-sub">stocks + options</div>
            </div>
            <div className="panel kpi">
              <div className="kpi-label">Cash / Stock / Put collateral</div>
              <div className="kpi-value" style={{ fontSize: 15 }}>
                {usd(summary.cash)} · {usd(summary.stockValue)} · {usd(summary.putCollateral)}
              </div>
              <div className="kpi-sub">
                {data.totals.shortPuts} short put{data.totals.shortPuts === 1 ? "" : "s"} · {data.totals.shortCalls} short call{data.totals.shortCalls === 1 ? "" : "s"}
              </div>
            </div>
          </div>

          {(summary.gammaGuard.length > 0 || summary.uncovered.length > 0) && (
            <div className="panel" style={{ marginBottom: 16 }}>
              <h2>Flags</h2>
              {summary.gammaGuard.map((o) => (
                <div key={`gg-${o.description}`} className="flag-row">
                  <span className="status-pill status-avoid">21 DTE Guard</span> {o.description} — {o.dte} DTE, {o.contracts} contract{o.contracts === 1 ? "" : "s"}
                </div>
              ))}
              {summary.uncovered.map((s) => (
                <div key={`uc-${s.ticker}`} className="flag-row">
                  <span className="status-pill status-watch">No covered call</span> {s.ticker} — {s.quantity} shares uncovered ({Math.floor(s.quantity / 100)} contract{Math.floor(s.quantity / 100) === 1 ? "" : "s"} available)
                </div>
              ))}
            </div>
          )}

          {data.accounts.map((a) => (
            <div key={a.last4} className="panel" style={{ marginBottom: 16 }}>
              <div className="candidates-header">
                <h2>
                  {a.name} …{a.last4}
                </h2>
                <div className="counts">
                  {usd(a.totalValue)} · cash {usd(accountCash(a))}
                  {a.lastHoldingsSync ? ` · broker sync ${new Date(a.lastHoldingsSync).toLocaleString()}` : ""}
                </div>
              </div>

              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Stock</th><th>Shares</th><th>Price</th><th>Avg cost</th><th>Value</th><th>P&amp;L</th><th>P&amp;L %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {a.stocks.length === 0 && (
                      <tr><td colSpan={7} className="empty-state" style={{ padding: 12 }}>No stock positions</td></tr>
                    )}
                    {a.stocks.map((s) => (
                      <tr key={s.ticker}>
                        <td><strong>{s.ticker}</strong></td>
                        <td>{s.quantity.toLocaleString()}</td>
                        <td>{usd(s.price, 2)}</td>
                        <td>{usd(s.avgCost, 2)}</td>
                        <td>{usd(s.marketValue)}</td>
                        <td className={signClass(s.gainUsd)}>{usd(s.gainUsd)}</td>
                        <td className={signClass(s.gainPct)}>{pct(s.gainPct)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="table-scroll" style={{ marginTop: 14 }}>
                <table>
                  <thead>
                    <tr>
                      <th>Option</th><th>Side</th><th>Qty</th><th>Strike</th><th>Expiry</th><th>DTE</th><th>Mark</th><th>Avg prem</th><th>P&amp;L</th><th>% captured</th>
                    </tr>
                  </thead>
                  <tbody>
                    {a.options.length === 0 && (
                      <tr><td colSpan={10} className="empty-state" style={{ padding: 12 }}>No option positions</td></tr>
                    )}
                    {[...a.options]
                      .sort((x, y) => (x.dte ?? 9999) - (y.dte ?? 9999))
                      .map((o) => (
                        <tr key={o.description + o.side}>
                          <td><strong>{o.ticker}</strong> {o.type.toUpperCase()}</td>
                          <td>{o.side}</td>
                          <td>{o.contracts}</td>
                          <td>{usd(o.strike, 2)}</td>
                          <td>{o.expiry ?? "—"}</td>
                          <td className={o.dte !== null && o.dte <= GAMMA_GUARD_DTE ? "day-down" : ""}>{o.dte ?? "—"}</td>
                          <td>{usd(o.mark, 2)}{o.markVerified ? "" : " *"}</td>
                          <td>{usd(o.avgPremium, 2)}</td>
                          <td className={signClass(o.gainUsd)}>{usd(o.gainUsd)}</td>
                          <td className={o.gainPct !== null && o.gainPct >= 50 ? "day-up" : signClass(o.gainPct)}>
                            {pct(o.gainPct)}{o.side === "short" && o.gainPct !== null && o.gainPct >= 50 ? " · close (50%+)" : ""}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              {a.options.some((o) => !o.markVerified) && (
                <div className="hint">* mark not reported by broker — derived from last price, treat as approximate.</div>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
