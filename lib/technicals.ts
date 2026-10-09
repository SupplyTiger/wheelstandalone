// RSI(14) + simple regular-divergence detection.
// Deliberately minimal (Ryan's instruction: features get added one at a time, not all at
// once) — this flags bullish/bearish divergence between price swing points and RSI swing
// points over a trailing window. It is a signal for the trader to look at, not an
// auto-approval gate.

import type { DailyBar } from "./yahooMarket";

export function computeRsiSeries(closes: number[], period = 14): (number | null)[] {
  const rsi: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length <= period) return rsi;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) gainSum += change;
    else lossSum += -change;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i += 1) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

type Pivot = { index: number; value: number };

function findPivots(values: number[], window: number, kind: "low" | "high"): Pivot[] {
  const pivots: Pivot[] = [];
  for (let i = window; i < values.length - window; i += 1) {
    const slice = values.slice(i - window, i + window + 1);
    const center = values[i];
    const isPivot = kind === "low" ? center === Math.min(...slice) : center === Math.max(...slice);
    if (isPivot) pivots.push({ index: i, value: center });
  }
  return pivots;
}

export type DivergenceSignal = "bullish" | "bearish" | "none";

export type TechnicalsResult = {
  rsi: number | null;
  divergence: DivergenceSignal;
  divergenceNote: string | null;
};

const NEUTRAL: TechnicalsResult = { rsi: null, divergence: "none", divergenceNote: null };

export function analyzeTechnicals(bars: DailyBar[], pivotWindow = 3, lookbackBars = 40): TechnicalsResult {
  if (bars.length < 30) return NEUTRAL;

  const recent = bars.slice(-lookbackBars);
  const closes = recent.map((b) => b.close);
  const rsiSeries = computeRsiSeries(closes, 14);
  const latestRsi = rsiSeries[rsiSeries.length - 1];

  const validIdx = rsiSeries.reduce<number[]>((acc, v, i) => (v !== null ? [...acc, i] : acc), []);
  if (validIdx.length < pivotWindow * 2 + 2) {
    return { rsi: latestRsi, divergence: "none", divergenceNote: null };
  }

  const priceLows = findPivots(closes, pivotWindow, "low");
  const priceHighs = findPivots(closes, pivotWindow, "high");

  const rsiAt = (i: number) => rsiSeries[i];

  // Bullish regular divergence: price makes a LOWER low while RSI makes a HIGHER low.
  if (priceLows.length >= 2) {
    const [prev, last] = priceLows.slice(-2);
    const rsiPrev = rsiAt(prev.index);
    const rsiLast = rsiAt(last.index);
    if (rsiPrev !== null && rsiLast !== null && last.value < prev.value && rsiLast > rsiPrev) {
      return {
        rsi: latestRsi,
        divergence: "bullish",
        divergenceNote: `Price lower low (${prev.value.toFixed(2)} -> ${last.value.toFixed(2)}) vs RSI higher low (${rsiPrev.toFixed(1)} -> ${rsiLast.toFixed(1)})`,
      };
    }
  }

  // Bearish regular divergence: price makes a HIGHER high while RSI makes a LOWER high.
  if (priceHighs.length >= 2) {
    const [prev, last] = priceHighs.slice(-2);
    const rsiPrev = rsiAt(prev.index);
    const rsiLast = rsiAt(last.index);
    if (rsiPrev !== null && rsiLast !== null && last.value > prev.value && rsiLast < rsiPrev) {
      return {
        rsi: latestRsi,
        divergence: "bearish",
        divergenceNote: `Price higher high (${prev.value.toFixed(2)} -> ${last.value.toFixed(2)}) vs RSI lower high (${rsiPrev.toFixed(1)} -> ${rsiLast.toFixed(1)})`,
      };
    }
  }

  return { rsi: latestRsi, divergence: "none", divergenceNote: null };
}
