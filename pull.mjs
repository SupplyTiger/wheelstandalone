import YahooFinance from 'yahoo-finance2';
const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
const tickers = {
  META:{spot:739, strikes:[750,800,850]},
  MSFT:{spot:519, strikes:[560,600,650]},
  GOOGL:{spot:341, strikes:[400,420,450]},
  AAPL:{spot:329, strikes:[360,380,400]},
  NVDA:{spot:227, strikes:[250,270,300]},
  TSM:{spot:459, strikes:[480,500,550]},
  PLTR:{spot:190, strikes:[200,220,250]},
  COIN:{spot:188, strikes:[220,250,280]},
};
const expsWanted = ['2026-12-18','2027-01-15'];
for (const [sym,cfg] of Object.entries(tickers)) {
  try {
    const q = await yf.quote(sym);
    console.log(`\n== ${sym} spot ${q.regularMarketPrice} day ${q.regularMarketChangePercent?.toFixed(2)}% ==`);
    const chain = await yf.options(sym);
    for (const expStr of expsWanted) {
      const expDate = chain.expirationDates.find(d=> d.toISOString().slice(0,10)===expStr);
      if(!expDate){ console.log(` no ${expStr}`); continue; }
      const o = await yf.options(sym,{date:expDate});
      const calls = o.options[0]?.calls||[];
      for (const s of cfg.strikes) {
        const c = calls.find(x=>x.strike===s);
        if(c) console.log(` ${expStr} $${s}C bid ${c.bid} ask ${c.ask} last ${c.lastPrice} IV ${(c.impliedVolatility*100).toFixed(1)}% OI ${c.openInterest} vol ${c.volume}`);
        else console.log(` ${expStr} $${s}C not found`);
      }
    }
  } catch(e){ console.log(sym, 'ERR', e.message); }
}
