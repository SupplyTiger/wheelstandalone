export type PositionKind = "stock" | "put" | "call" | "cash";

export type WheelPosition = {
  id?: string;
  ticker: string;
  symbol?: string;
  kind: PositionKind;
  side?: "short" | "long";
  quantity: number;
  strike?: number | null;
  expiry?: string | null;
  price: number;
  avgCost?: number | null;
  currentValue?: number | null;
  gainUsd?: number | null;
  gainPct?: number | null;
  optionMarkVerified?: boolean | null;
};

export type AccountSnapshot = {
  id?: string;
  accountValue: number;
  floor: number;
  cash?: number | null;
  buyingPower?: number | null;
  cashSecuredPutCapacity?: number | null;
  source?: string | null;
  syncedAt?: string | null;
};

export type QuoteSnapshot = {
  ticker: string;
  price: number | null;
  previousClose: number | null;
  change: number | null;
  changePct: number | null;
  source: string;
  quality: "VERIFIED" | "FALLBACK" | "MISSING";
  timestamp: string;
};

export type OptionContract = {
  contractSymbol: string;
  strike: number;
  expiry: string;
  kind: "put" | "call";
  bid: number | null;
  ask: number | null;
  lastPrice: number | null;
  openInterest: number;
  volume?: number | null;
  impliedVolatility: number | null;
};

export type ScreenerCandidate = {
  ticker: string;
  price: number | null;
  changePct: number | null;
  quoteQuality: QuoteSnapshot["quality"];
  strike: number;
  expiry: string;
  dte: number;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  spreadPct: number | null;
  openInterest: number | null;
  optionVolume: number | null;
  ivRank: number | null;
  rsi14: number | null;
  wk52Pos: number | null;
  laneStatus: "ALERT_READY" | "WATCH" | "AVOID" | "DEFENSE_REVIEW";
  strategyLane: "STANDARD_CSP" | "SNIPER_CSP" | "OUT_OF_LANE" | "DEFENSE";
  roiPct: number | null;
  annRoiPct: number | null;
  maxPain: number | null;
  maxPainGapPct: number | null;
  rule6: "GREEN" | "RED" | "UNKNOWN";
  gate0: "PASS" | "WARN" | "BLOCK";
  score: number;
  decisionReason: string;
};

export type GateResult = {
  passed: boolean;
  gateName: string;
  reason?: string;
};
