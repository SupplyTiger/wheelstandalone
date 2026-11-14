// Metric-generic outlier engine — the "X, Y, or Z" design.
//
// Ryan's clarification for the PMCC screener: the outlier flags must be GENERIC
// across metrics, not hardcoded to one named metric. So this module knows nothing
// about options, IV, or PMCCs. It takes any list of items and any list of metric
// definitions, measures every item against the population on each metric, and
// flags the tails.
//
// HOW TO ADD A METRIC (the whole point of this file): add ONE entry to the
// caller's metric array — { key, label, get, good } — and it is automatically
// measured, population-stat'd, and flagged like every other metric. No change
// to this module, no change to the route, no change to the response shape.
//
// STATISTIC: robust z-score against the population median, not the mean:
//   z = 0.6745 * (x - median) / MAD, where MAD = median(|x - median|).
// The median/MAD pair is used deliberately: a mean/std z-score lets one extreme
// value drag the mean toward itself and shrink its own z (masking), which is
// exactly backwards for an outlier screen. Edge behavior falls out naturally:
//   - MAD = 0 with no spread at all (everyone identical) → all z = 0, nothing
//     flags. Correct: with no spread there is no outlier.
//   - MAD = 0 WITH spread (more than half the population identical, one far
//     value — the classic case) → falls back to mean absolute deviation from
//     the median, so the far value still flags. Without this fallback a
//     7-identical-plus-1-outlier population would report "no outliers".
//   - Tiny populations (n = 1 or 2) → |z| maxes out at 0.6745, below any sane
//     threshold, so nothing flags. Correct: two points cannot establish a tail.
//   - Missing values (get returns null) → the item is excluded from that
//     metric's population entirely, never treated as zero.
// A flag fires at |z| >= threshold (default 2). A flag is NOT a verdict: it
// says "this number is far from its peers, look at it" — good or bad depends
// on the metric's `good` side, and "either" metrics are pure oddities.

export type MetricDef<T> = {
  /** Stable machine key, used in the response and in tests. */
  key: string;
  /** Human label for the flag. */
  label: string;
  /** The metric's value for one item; null = unavailable, excluded from the population. */
  get: (item: T) => number | null;
  /**
   * Which tail is favorable for the trade: "high" (bigger is better, e.g. yield),
   * "low" (smaller is better, e.g. cost), "either" (a tail in either direction is
   * just an oddity worth noticing, e.g. a skew dislocation).
   */
  good: "high" | "low" | "either";
};

export type OutlierFlag = {
  metric: string;
  label: string;
  value: number;
  median: number;
  robustZ: number;
  direction: "high" | "low";
  goodSide: "high" | "low" | "either";
};

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Robust z-scores for one population, in input order; null where input was null. */
export function robustZScores(values: Array<number | null>): Array<number | null> {
  const present = values.filter((v): v is number => v !== null);
  const med = median(present);
  if (med === null) return values.map(() => null);
  let spread = median(present.map((v) => Math.abs(v - med))) ?? 0;
  if (spread === 0) {
    // Majority-identical population: MAD is blind here, so fall back to mean
    // absolute deviation from the median (still 0 when truly flat).
    spread = present.reduce((sum, v) => sum + Math.abs(v - med), 0) / present.length;
  }
  if (spread === 0) return values.map((v) => (v === null ? null : 0));
  return values.map((v) => (v === null ? null : Number((0.6745 * ((v - med) / spread)).toFixed(3))));
}

/**
 * Flag population outliers across all metrics. Returns one flag array per item,
 * in the same order as `items`. Items with no flags get an empty array — never
 * null, so callers can always map 1:1 onto their rows.
 */
export function computeOutlierFlags<T>(
  items: T[],
  metrics: Array<MetricDef<T>>,
  threshold = 2,
): OutlierFlag[][] {
  const flags: OutlierFlag[][] = items.map(() => []);
  for (const metric of metrics) {
    const values = items.map((item) => metric.get(item));
    const present = values.filter((v): v is number => v !== null);
    const med = median(present);
    if (med === null) continue;
    const zScores = robustZScores(values);
    for (let i = 0; i < items.length; i++) {
      const z = zScores[i];
      const value = values[i];
      if (z === null || value === null || Math.abs(z) < threshold) continue;
      flags[i].push({
        metric: metric.key,
        label: metric.label,
        value: Number(value.toFixed(4)),
        median: Number(med.toFixed(4)),
        robustZ: z,
        direction: z >= 0 ? "high" : "low",
        goodSide: metric.good,
      });
    }
  }
  return flags;
}

/** Population summary per metric, for the response's `metrics` block. */
export function metricPopulations<T>(
  items: T[],
  metrics: Array<MetricDef<T>>,
): Record<string, { n: number; median: number | null }> {
  const out: Record<string, { n: number; median: number | null }> = {};
  for (const metric of metrics) {
    const present = items.map((item) => metric.get(item)).filter((v): v is number => v !== null);
    out[metric.key] = { n: present.length, median: median(present) };
  }
  return out;
}
