// Ticker universe pulled from "Wheel Watchlist Tiers - Living Doc (v7)" (Ryan Brain,
// updated 2026-08-24) — the canonical source, not the old 12-name subset. Single source
// of truth shared by the UI's default watchlist and scripts/full-scan.ts, so the two
// never drift apart.

export const DO_NOT_ADD = ["MU", "SLV"]; // existing concentration violations, rotate OUT only

export const FULL_UNIVERSE = [
  "AAL","AAPL","ABB","ABBV","ABNB","ABT","ACHR","ADBE","ADI","ADSK","AFRM","AI","AMAT","AMBA",
  "AMD","AMGN","AMZN","ANET","ANSS","APP","ARM","ASML","ASTS","AVAV","AVGO","BA","BABA","BAH",
  "BBAI","BIDU","BIIB","BKNG","BMY","BSX","CCL","CDNS","CEG","CERT","CEVA","CF","CFLT","CGNX",
  "CHWY","CIEN","CIFR","CLSK","CNC","COHR","COIN","COST","CRM","CRWD","CRWV","CVS","CVX","DAL",
  "DASH","DDOG","DE","DELL","DIS","DLR","DXCM","ELV","EMR","ENPH","EQIX","ESTC","ETN","EW","EXEL",
  "F","FANUY","FORM","FTNT","GE","GEV","GILD","GM","GOOGL","HCA","HCAT","HIMS","HON","HOOD","HUBB",
  "HUBS","HUM","IBB","IBM","ILMN","INTC","INTU","IONQ","IQV","IREN","ISRG","IWM","JCI","JNJ","JOBY",
  "KLAC","KO","LLY","LRCX","LUNR","LYFT","MARA","MCHP","MDB","MDT","META","MOS","MPWR","MRK","MRNA",
  "MRVL","MSFT","MSTR","NET","NFLX","NKE","NOW","NTRA","NU","NVDA","NXPI","OKLO","OKTA","ON","ORCL",
  "PANW","PATH","PEP","PFE","PLTR","PLUG","PSTG","PWR","PYPL","QCOM","QQQ","QS","RCL","RDW","RGTI",
  "RIOT","RKLB","ROK","RUN","RXRX","S","SBUX","SDGR","SHOP","SMCI","SNOW","SNPS","SOFI","SOUN","SPY",
  "SQ","STX","SYM","T","TEAM","TEM","TER","TGT","TLT","TSLA","TSM","TWLO","TXN","UBER","ULTA","UNH",
  "VEEV","VKTX","VRT","VRTX","VST","VTRS","VZ","WDC","WMT","WULF","XBI","XLV","XOM","ZBRA","ZS","ZTS",
  "TCEHY",
];

// Tier 1 (Safest Institutional) + Tier 2 (Preferred) + Tier 3 (High-Premium/High-Beta),
// deduped, DO-NOT-ADD names excluded. This is the UI's default watchlist: small enough
// for one live request to finish inside a serverless function's time budget. The full
// ~194-name universe above is what scripts/full-scan.ts batches through instead — running
// all of it through a single web request risks a platform timeout, not just a Yahoo
// rate-limit (that's why full-scan.ts exists as a separate, throttled tool).
export const CORE_WATCHLIST = Array.from(
  new Set([
    // Tier 1 - Safest Institutional
    "MSFT", "GOOGL", "QCOM", "IBM", "AMZN", "ORCL",
    // Tier 2 - Preferred
    "QCOM", "GOOGL", "META", "TGT", "RKLB", "AVAV", "TSM",
    // Tier 3 - High-Premium / High-Beta (Theta Sniper fuel)
    "MSTR", "SMCI", "PLTR", "COIN", "ASTS", "RKLB", "IONQ",
  ]),
).filter((t) => !DO_NOT_ADD.includes(t));
