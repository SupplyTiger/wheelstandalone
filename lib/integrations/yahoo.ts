import type { OptionContract, QuoteSnapshot } from "@/lib/types";

const YAHOO_BASE = "https://query1.finance.yahoo.com";
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36";
const MIN_REQUEST_SPACING_MS = 750;
const MAX_ATTEMPTS = 3;
const CACHE_TTL_MS = 60 * 1000;
const STALE_CACHE_TTL_MS = 10 * 60 * 1000;

let yahooAuth: { crumb: string; cookie: string; expiresAt: number } | null = null;
let yahooAuthPromise: Promise<{ crumb: string; cookie: string; expiresAt: number }> | null = null;
let yahooLastRequestAt = 0;
let yahooRequestQueue = Promise.resolve();
const yahooResponseCache = new Map<string, { data: unknown; expiresAt: number; staleUntil: number }>();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForYahooSlot() {
  const run = yahooRequestQueue.then(async () => {
    const elapsed = Date.now() - yahooLastRequestAt;
    const waitMs = Math.max(0, MIN_REQUEST_SPACING_MS - elapsed);
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    yahooLastRequestAt = Date.now();
  });
  yahooRequestQueue = run.catch(() => undefined);
  await run;
}

function retryAfterMs(response: Response) {
  const retryAfter = response.headers.get("retry-after");
  if (!retryAfter) return null;

  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const dateMs = Date.parse(retryAfter);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : null;
}

async function yahooRequest(url: string, init: RequestInit) {
  await waitForYahooSlot();
  return fetch(url, init);
}

async function getYahooAuth() {
  if (yahooAuth && yahooAuth.expiresAt > Date.now()) {
    return yahooAuth;
  }

  yahooAuthPromise ??= (async () => {
    const cookieResponse = await yahooRequest("https://fc.yahoo.com", {
      headers: { "user-agent": USER_AGENT },
      cache: "no-store",
      redirect: "manual"
    });
    const cookie = cookieResponse.headers.getSetCookie?.().join("; ") ?? cookieResponse.headers.get("set-cookie") ?? "";
    if (!cookie) {
      throw new Error("Yahoo Finance auth cookie was not returned");
    }

    const crumbResponse = await yahooRequest(`${YAHOO_BASE}/v1/test/getcrumb`, {
      headers: {
        cookie,
        "user-agent": USER_AGENT
      },
      cache: "no-store"
    });
    if (!crumbResponse.ok) {
      throw new Error(`Yahoo Finance crumb ${crumbResponse.status}: ${await crumbResponse.text()}`);
    }

    const crumb = (await crumbResponse.text()).trim();
    yahooAuth = { crumb, cookie, expiresAt: Date.now() + 30 * 60 * 1000 };
    return yahooAuth;
  })().finally(() => {
    yahooAuthPromise = null;
  });

  return yahooAuthPromise;
}

async function yahooFetch<T>(path: string, options: { crumb?: boolean; retry?: boolean } = {}): Promise<T> {
  const auth = options.crumb ? await getYahooAuth() : null;
  const separator = path.includes("?") ? "&" : "?";
  const authedPath = auth ? `${path}${separator}crumb=${encodeURIComponent(auth.crumb)}` : path;
  const cacheKey = `${auth ? "auth" : "public"}:${authedPath}`;
  const cached = yahooResponseCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.data as T;
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const response = await yahooRequest(`${YAHOO_BASE}${authedPath}`, {
      headers: {
        accept: "application/json",
        "user-agent": USER_AGENT,
        ...(auth ? { cookie: auth.cookie } : {})
      },
      next: { revalidate: 60 }
    });

    if (response.ok) {
      const data = (await response.json()) as T;
      yahooResponseCache.set(cacheKey, {
        data,
        expiresAt: Date.now() + CACHE_TTL_MS,
        staleUntil: Date.now() + STALE_CACHE_TTL_MS
      });
      return data;
    }

    const text = await response.text();
    if (options.crumb && options.retry !== false && response.status === 401) {
      yahooAuth = null;
      return yahooFetch<T>(path, { ...options, retry: false });
    }

    if (response.status === 429 && attempt < MAX_ATTEMPTS) {
      const retryMs = retryAfterMs(response) ?? 1500 * attempt;
      await sleep(retryMs);
      continue;
    }

    if (response.status === 429 && cached && cached.staleUntil > now) {
      return cached.data as T;
    }
    throw new Error(`Yahoo Finance ${response.status}: ${text}`);
  }

  if (cached && cached.staleUntil > Date.now()) {
    return cached.data as T;
  }
  throw new Error("Yahoo Finance 429: rate limited after retries");
}

export async function getQuoteSnapshot(ticker: string): Promise<QuoteSnapshot> {
  const symbol = ticker.trim().toUpperCase();
  const empty: QuoteSnapshot = {
    ticker: symbol,
    price: null,
    previousClose: null,
    change: null,
    changePct: null,
    source: "yahoo.chart",
    quality: "MISSING",
    timestamp: new Date().toISOString()
  };

  if (!symbol) return empty;

  type ChartResponse = {
    chart?: {
      result?: Array<{
        meta?: {
          regularMarketPrice?: number;
          chartPreviousClose?: number;
          previousClose?: number;
        };
        indicators?: { quote?: Array<{ close?: Array<number | null> }> };
      }>;
    };
  };

  const data = await yahooFetch<ChartResponse>(`/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`);
  const result = data.chart?.result?.[0];
  const price = result?.meta?.regularMarketPrice ?? null;
  const previousClose =
    result?.meta?.previousClose ??
    result?.meta?.chartPreviousClose ??
    result?.indicators?.quote?.[0]?.close?.filter((value): value is number => typeof value === "number").at(-2) ??
    null;

  if (price === null || previousClose === null || previousClose <= 0) {
    return { ...empty, price, previousClose, quality: price !== null ? "FALLBACK" : "MISSING" };
  }

  const change = price - previousClose;
  return {
    ticker: symbol,
    price,
    previousClose,
    change,
    changePct: (change / previousClose) * 100,
    source: "yahoo.chart",
    quality: "VERIFIED",
    timestamp: new Date().toISOString()
  };
}

export async function getOptionChain(ticker: string, expiryUnix?: number): Promise<OptionContract[]> {
  const symbol = ticker.trim().toUpperCase();
  const dateParam = expiryUnix ? `?date=${expiryUnix}` : "";

  type YahooOption = {
    contractSymbol?: string;
    strike?: number;
    bid?: number;
    ask?: number;
    lastPrice?: number;
    openInterest?: number;
    impliedVolatility?: number;
  };
  type OptionsResponse = {
    optionChain?: {
      result?: Array<{
        expirationDates?: number[];
        options?: Array<{ calls?: YahooOption[]; puts?: YahooOption[] }>;
      }>;
    };
  };

  const initial = await yahooFetch<OptionsResponse>(
    `/v7/finance/options/${encodeURIComponent(symbol)}${dateParam}`,
    { crumb: true }
  );
  const chain = initial.optionChain?.result?.[0];
  const selectedDate = expiryUnix ?? chain?.expirationDates?.[0];
  if (!selectedDate) return [];

  const optionsBlock =
    expiryUnix || chain?.options?.[0]
      ? chain?.options?.[0]
      : (
          await yahooFetch<OptionsResponse>(
            `/v7/finance/options/${encodeURIComponent(symbol)}?date=${selectedDate}`,
            { crumb: true }
          )
        ).optionChain?.result?.[0]?.options?.[0];

  const expiry = new Date(selectedDate * 1000).toISOString().slice(0, 10);
  const mapOption = (kind: "put" | "call") => (option: YahooOption): OptionContract | null => {
    if (!option.contractSymbol || typeof option.strike !== "number") return null;
    return {
      contractSymbol: option.contractSymbol,
      strike: option.strike,
      expiry,
      kind,
      bid: typeof option.bid === "number" ? option.bid : null,
      ask: typeof option.ask === "number" ? option.ask : null,
      lastPrice: typeof option.lastPrice === "number" ? option.lastPrice : null,
      openInterest: typeof option.openInterest === "number" ? option.openInterest : 0,
      impliedVolatility: typeof option.impliedVolatility === "number" ? option.impliedVolatility : null
    };
  };

  return [
    ...(optionsBlock?.calls ?? []).map(mapOption("call")),
    ...(optionsBlock?.puts ?? []).map(mapOption("put"))
  ].filter((option): option is OptionContract => Boolean(option));
}

export async function getExpirationDates(ticker: string): Promise<number[]> {
  type OptionsResponse = {
    optionChain?: { result?: Array<{ expirationDates?: number[] }> };
  };
  const data = await yahooFetch<OptionsResponse>(
    `/v7/finance/options/${encodeURIComponent(ticker.trim().toUpperCase())}`,
    { crumb: true }
  );
  return data.optionChain?.result?.[0]?.expirationDates ?? [];
}
