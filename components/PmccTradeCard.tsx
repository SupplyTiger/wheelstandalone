// Annotated trade card for a PMCC short call (Wheel Rules v2.1).
// Presentational only: pass it the output of buildPmccRoiCard() (lib/pmcc.ts), computed
// server-side. Optionally shows the Capital Defense basis line (raw basis + ACB) for
// share-backed covered calls.
//
// Not mounted yet: this repo has no PMCC / covered-call entry flow on main. The Action Center
// or Positions tab should render it once that flow exists.

import type { PmccRoiCard } from "../lib/pmcc";

const usd = (n: number | null) =>
  n === null ? "—" : n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const pct = (n: number | null) => (n === null ? "—" : `${n.toFixed(2)}%`);

export function PmccTradeCard({
  title,
  card,
  basis,
}: {
  title: string;
  card: PmccRoiCard;
  basis?: { raw: number; acb: number } | null;
}) {
  return (
    <div className="panel">
      <div className="candidates-header">
        <h2>{title}</h2>
        <span className={`status-pill ${card.verdict === "APPROVED" ? "status-ready" : "status-avoid"}`}>{card.verdict}</span>
      </div>
      <table>
        <tbody>
          <tr><td>Credit</td><td>{usd(card.credit)}</td><td>Net debit</td><td>{usd(card.netDebit)}</td></tr>
          <tr><td>Credit / net debit</td><td>{pct(card.creditOverNetDebitPct)}</td><td>Credit / max loss</td><td>{pct(card.creditOverMaxLossPct)}</td></tr>
          <tr><td>Annualized</td><td>{pct(card.annualizedPct)}</td><td>DTE</td><td>{card.dte}</td></tr>
          {basis && (
            <tr><td>Raw basis</td><td>{usd(basis.raw)}</td><td>Adjusted cost basis</td><td>{usd(basis.acb)}</td></tr>
          )}
        </tbody>
      </table>
      <div style={{ marginTop: 10 }}>
        {card.gates.map((g) => (
          <div key={g.gateName + (g.reason ?? "")} className="hint">
            <span className={`status-pill ${g.status === "pass" ? "status-ready" : g.status === "block" ? "status-avoid" : "status-watch"}`}>
              {g.status.toUpperCase()}
            </span>{" "}
            {g.gateName}
            {g.reason ? ` — ${g.reason}` : ""}
          </div>
        ))}
      </div>
    </div>
  );
}
