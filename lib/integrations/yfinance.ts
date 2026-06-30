import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { OptionContract, QuoteSnapshot } from "@/lib/types";

const execFileAsync = promisify(execFile);
const BRIDGE_PATH = path.join(process.cwd(), "scripts", "yfinance_bridge.py");
const LOCAL_PYTHON = path.join(process.cwd(), ".venv", "bin", "python");
const PYTHON_BIN = process.env.PYTHON_BIN || process.env.PYTHON || (fs.existsSync(LOCAL_PYTHON) ? LOCAL_PYTHON : "python3");
const MIN_BRIDGE_SPACING_MS = 750;
const CACHE_TTL_MS = 60 * 1000;
const STALE_CACHE_TTL_MS = 10 * 60 * 1000;

type YfinanceSnapshot = {
  ticker: string;
  quote: QuoteSnapshot;
  technicals?: {
    rsi14?: number | null;
    wk52_pos?: number | null;
  };
  expirations: Array<{ unix: number; date: string }>;
  selectedExpiry: string | null;
  selectedExpiries?: string[];
  options: OptionContract[];
};

let lastBridgeCallAt = 0;
let bridgeQueue = Promise.resolve();
const snapshotCache = new Map<string, { data: YfinanceSnapshot; expiresAt: number; staleUntil: number }>();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForBridgeSlot() {
  const run = bridgeQueue.then(async () => {
    const elapsed = Date.now() - lastBridgeCallAt;
    const waitMs = Math.max(0, MIN_BRIDGE_SPACING_MS - elapsed);
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    lastBridgeCallAt = Date.now();
  });
  bridgeQueue = run.catch(() => undefined);
  await run;
}

function cacheKey(ticker: string, expiry?: string | number | null, dteMin = 7, dteMax = 60) {
  return `${ticker.trim().toUpperCase()}:${expiry ?? ""}:${dteMin}:${dteMax}`;
}

export async function getYfinanceSnapshot(
  ticker: string,
  expiry?: string | number | null,
  dteMin = 7,
  dteMax = 60
): Promise<YfinanceSnapshot> {
  const symbol = ticker.trim().toUpperCase();
  const key = cacheKey(symbol, expiry, dteMin, dteMax);
  const cached = snapshotCache.get(key);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.data;
  }

  await waitForBridgeSlot();
  try {
    const args = [BRIDGE_PATH, "snapshot", symbol];
    args.push(expiry ? String(expiry) : "-", String(dteMin), String(dteMax));
    const { stdout } = await execFileAsync(PYTHON_BIN, args, {
      cwd: process.cwd(),
      maxBuffer: 8 * 1024 * 1024,
      timeout: 45_000
    });
    const data = JSON.parse(stdout) as YfinanceSnapshot;
    snapshotCache.set(key, {
      data,
      expiresAt: Date.now() + CACHE_TTL_MS,
      staleUntil: Date.now() + STALE_CACHE_TTL_MS
    });
    return data;
  } catch (error) {
    if (cached && cached.staleUntil > Date.now()) {
      return cached.data;
    }
    throw error;
  }
}

export async function getQuoteSnapshot(ticker: string): Promise<QuoteSnapshot> {
  return (await getYfinanceSnapshot(ticker)).quote;
}
