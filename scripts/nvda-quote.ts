import YahooFinance from "yahoo-finance2";
const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"], validation: { logErrors: false, logOptionsErrors: false } });
async function main() {
  const first: any = await yf.options("NVDA");
  const exps = (first.expirationDates ?? []).map((d: any) => new Date(d).toISOString().slice(0, 10));
  const jan27 = exps.find((e: string) => e.startsWith("2027-01"));
  console.log("underlying:", first.quote?.regularMarketPrice, "chgPct:", first.quote?.regularMarketChangePercent, "jan27:", jan27);
  const chain: any = await yf.options("NVDA", { date: new Date(jan27 + "T00:00:00Z") });
  for (const c of (chain.options?.[0]?.calls ?? [])) {
    if (c.strike === 235 || c.strike === 265)
      console.log(c.strike + "C:", "bid", c.bid, "ask", c.ask, "last", c.lastPrice, "iv", c.impliedVolatility?.toFixed?.(3));
  }
}
main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
