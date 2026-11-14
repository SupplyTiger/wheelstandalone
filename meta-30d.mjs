import YahooFinance from 'yahoo-finance2';
const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
// Black-Scholes delta for a call
function normCDF(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}
function callDelta(S, K, T, r, iv) {
  const d1 = (Math.log(S / K) + (r + iv * iv / 2) * T) / (iv * Math.sqrt(T));
  return normCDF(d1);
}
const sym = 'META', exp = '2026-10-23', r = 0.0425;
const q = await yf.quote(sym);
const S = q.regularMarketPrice;
console.log(`META spot ${S} (${q.regularMarketChangePercent?.toFixed(2)}%)`);
const chain = await yf.options(sym);
const expDate = chain.expirationDates.find(d => d.toISOString().slice(0, 10) === exp);
const o = await yf.options(sym, { date: expDate });
const calls = o.options[0]?.calls || [];
const today = new Date('2026-10-13T16:00:00-04:00');
const T = (expDate - today) / (365 * 24 * 3600 * 1000);
console.log(`TTE ${T.toFixed(4)} yrs`);
console.log('strike | bid x ask | IV% | delta | OI');
for (const c of calls) {
  if (c.strike < 760 || c.strike > 880 || c.strike % 5 !== 0) continue;
  const mid = (c.bid + c.ask) / 2;
  const d = callDelta(S, c.strike, T, r, c.impliedVolatility);
  console.log(`${c.strike} | ${c.bid} x ${c.ask} | ${(c.impliedVolatility * 100).toFixed(1)} | ${d.toFixed(3)} | ${c.openInterest}`);
}
