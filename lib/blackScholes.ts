// Put delta via Black-Scholes — added because the screener was picking near-ATM strikes
// (e.g. spot $62.01 / strike $62.00) as "best" candidates. ROI dominates the score, and
// ROI is highest right at the money, so without a moneyness check the screener drifted
// toward exactly the kind of high-assignment-probability strikes the wheel mandate's
// "0.30 Delta" entry filter exists to keep out. Yahoo's options data gives implied
// volatility but not greeks directly, so delta is computed here from spot/strike/DTE/IV.

const RISK_FREE_RATE = 0.045; // fixed short-term-rate approximation, not live data - delta
// is not very sensitive to small rate moves over a 7-60 day window, so this is fine.

function normalCdf(x: number): number {
  // Abramowitz-Stegun approximation (~1e-7 accurate) - no external stats library needed.
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + p * ax);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}

// Returns the put's delta (always in [-1, 0]) or null when inputs can't produce a
// meaningful value (missing/zero IV, non-positive spot/strike/DTE).
export function putDelta(spot: number | null, strike: number | null, dte: number | null, ivDecimal: number | null): number | null {
  if (spot === null || spot <= 0) return null;
  if (strike === null || strike <= 0) return null;
  if (dte === null || dte <= 0) return null;
  if (ivDecimal === null || ivDecimal <= 0) return null;
  const T = Math.max(dte, 1) / 365;
  const sigma = ivDecimal;
  const d1 = (Math.log(spot / strike) + (RISK_FREE_RATE + (sigma * sigma) / 2) * T) / (sigma * Math.sqrt(T));
  return normalCdf(d1) - 1;
}
