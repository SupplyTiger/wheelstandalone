import type { ReactNode } from "react";

// Honest stand-in for a tab that hasn't been rebuilt yet. The old dashboard's Portfolio /
// Action Center / Positions / Activity tabs were wired to a Postgres + SnapTrade backend
// that isn't part of this rebuild (and isn't configured here) - rather than show fabricated
// numbers or a broken "Connect" button, this just says plainly what's coming and when.
// Matches the Screener tab's card styling so it reads as one app, not a stub bolted on.
export function PlaceholderTab({ title, icon, description }: { title: string; icon: ReactNode; description: string }) {
  return (
    <div className="panel placeholder-panel">
      <div className="placeholder-icon">{icon}</div>
      <h2>{title}</h2>
      <p className="placeholder-body">{description}</p>
      <p className="placeholder-note">Not rebuilt yet - no fabricated numbers here, just a clean stand-in until this tab gets the same treatment as the Screener.</p>
    </div>
  );
}
