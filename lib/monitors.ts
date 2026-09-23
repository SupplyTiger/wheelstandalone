// Position monitors / alerts, Wheel Rules v2.1.
// Pure functions: given a position snapshot, return the alerts that should fire. There was no
// alerts system in this repo, so these return Alert[] for the UI (Portfolio/Action Center) to
// render; nothing here places or cancels orders.

import { loadWheelRules, type WheelRules } from "./rules";

export type AlertCode =
  | "THETA_SNIPER"
  | "TIME_STOP"
  | "HARVEST_SPREAD"
  | "ROLL_LEAPS"
  | "REVIEW_LEAPS"
  | "EARLY_ASSIGNMENT";

export type Alert = { code: AlertCode; title: string; detail: string };

export type AccountType = "brokerage" | "ira";

/** Fraction of the opening credit already captured on a short option (0.6 = 60%). */
export function decayCaptured(openCreditPerShare: number, markPerShare: number): number | null {
  if (!(openCreditPerShare > 0)) return null;
  return (openCreditPerShare - markPerShare) / openCreditPerShare;
}

/** Extrinsic value of a short call: mark minus intrinsic. */
export function callExtrinsic(markPerShare: number, spot: number, strike: number): number {
  return markPerShare - Math.max(0, spot - strike);
}

export type PmccSnapshot = {
  ticker: string;
  spot: number;
  leaps: { strike: number; dte: number; costPerShare: number; markPerShare: number };
  short: { strike: number; dte: number; openCreditPerShare: number; markPerShare: number } | null;
  /** Upcoming ex-dividend, if known. */
  exDividend?: { daysAway: number; amountPerShare: number } | null;
};

export function evaluatePmccMonitors(p: PmccSnapshot, rules: WheelRules = loadWheelRules()): Alert[] {
  const alerts: Alert[] = [];
  const r = rules.pmcc;

  if (p.short) {
    const decay = decayCaptured(p.short.openCreditPerShare, p.short.markPerShare);
    const hitTarget = decay !== null && decay >= r.short.profitTarget - 1e-9;
    if (hitTarget) {
      alerts.push({
        code: "THETA_SNIPER",
        title: "Theta Sniper: buy back",
        detail: `${p.ticker} ${p.short.strike}C has captured ${Math.round((decay as number) * 100)}% of credit (target ${Math.round(r.short.profitTarget * 100)}%)`,
      });
    }
    if (p.short.dte <= r.short.timeStopDte && !hitTarget) {
      alerts.push({
        code: "TIME_STOP",
        title: "Time stop",
        detail: `${p.ticker} ${p.short.strike}C at ${p.short.dte} DTE without reaching the ${Math.round(r.short.profitTarget * 100)}% target`,
      });
    }

    const width = p.short.strike - p.leaps.strike;
    const spreadValue = p.leaps.markPerShare - p.short.markPerShare;
    const extrinsic = callExtrinsic(p.short.markPerShare, p.spot, p.short.strike);
    if ((width > 0 && spreadValue >= r.harvest.spreadWidthPct * width - 1e-9) || extrinsic <= r.harvest.minShortExtrinsic + 1e-9) {
      alerts.push({
        code: "HARVEST_SPREAD",
        title: "Harvest spread",
        detail: `${p.ticker} spread worth ${spreadValue.toFixed(2)} of ${width.toFixed(2)} width; short extrinsic ${extrinsic.toFixed(2)}`,
      });
    }

    const itm = p.spot > p.short.strike;
    const ex = p.exDividend;
    if (itm && ex && ex.daysAway >= 0 && ex.daysAway <= rules.exDividend.windowDays && extrinsic < ex.amountPerShare) {
      alerts.push({
        code: "EARLY_ASSIGNMENT",
        title: "Early assignment risk",
        detail: `${p.ticker} ${p.short.strike}C is ITM, ex-div in ${ex.daysAway}d, extrinsic ${extrinsic.toFixed(2)} < dividend ${ex.amountPerShare.toFixed(2)} - close or roll before ex-div`,
      });
    }
  }

  if (p.leaps.dte <= r.leaps.rollOutDte) {
    alerts.push({ code: "ROLL_LEAPS", title: "Roll LEAPS out", detail: `${p.ticker} ${p.leaps.strike}C LEAPS at ${p.leaps.dte} DTE (roll at ${r.leaps.rollOutDte})` });
  }
  if (p.leaps.costPerShare > 0) {
    const change = (p.leaps.markPerShare - p.leaps.costPerShare) / p.leaps.costPerShare;
    if (change <= -r.leaps.reviewDrawdownPct + 1e-9) {
      alerts.push({ code: "REVIEW_LEAPS", title: "Review LEAPS", detail: `${p.ticker} ${p.leaps.strike}C LEAPS down ${Math.round(-change * 100)}% from cost` });
    }
  }
  return alerts;
}

export type CspSnapshot = {
  ticker: string;
  strike: number;
  dte: number;
  openCreditPerShare: number;
  markPerShare: number;
  account: AccountType;
};

/** Wheel CSP monitors: profit target by account (50% brokerage / 75% IRA) and 21 DTE time stop. */
export function evaluateCspMonitors(p: CspSnapshot, rules: WheelRules = loadWheelRules()): Alert[] {
  const alerts: Alert[] = [];
  const target = rules.csp.profitTarget[p.account];
  const decay = decayCaptured(p.openCreditPerShare, p.markPerShare);
  const hit = decay !== null && decay >= target - 1e-9;
  if (hit) {
    alerts.push({
      code: "THETA_SNIPER",
      title: "Theta Sniper: buy back",
      detail: `${p.ticker} ${p.strike}P captured ${Math.round((decay as number) * 100)}% (${p.account} target ${Math.round(target * 100)}%)`,
    });
  }
  if (p.dte <= rules.csp.timeStopDte && !hit) {
    alerts.push({ code: "TIME_STOP", title: "Time stop", detail: `${p.ticker} ${p.strike}P at ${p.dte} DTE without reaching ${Math.round(target * 100)}%` });
  }
  return alerts;
}
