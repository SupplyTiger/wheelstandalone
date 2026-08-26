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

// Theme clusters, ported straight from the v7 doc's "THEME CLUSTERS" + "HEALTHCARE /
// MEDICAL" sections. A ticker can legitimately sit in more than one cluster (QCOM is both
// Preferred-tier and Semis, JNJ is both a Yield Anchor and Healthcare) - that's the doc's
// own categorization, not a bug. DO-NOT-ADD names are filtered out defensively even though
// none currently land in a named cluster.
const RAW_CLUSTERS: { name: string; tickers: string[] }[] = [
  { name: "AI Infrastructure", tickers: ["NVDA", "AVGO", "SMCI", "VRT", "DELL", "ANET", "ARM"] },
  { name: "Semis", tickers: ["AMD", "QCOM", "MRVL", "AMAT", "KLAC", "LRCX", "TXN", "NXPI", "ON", "TSM"] },
  { name: "Quantum", tickers: ["IONQ", "RGTI"] },
  { name: "Space / Defense", tickers: ["RKLB", "LUNR", "RDW", "AVAV", "JOBY"] },
  { name: "AI Software", tickers: ["PLTR", "AI", "PATH", "DDOG", "SNOW", "MDB", "ESTC", "NOW"] },
  { name: "AI Security", tickers: ["CRWD", "PANW", "ZS", "S", "NET", "FTNT", "OKTA"] },
  { name: "Cloud / Megacap", tickers: ["MSFT", "AMZN", "META", "GOOGL", "ORCL"] },
  { name: "Crypto / High Beta", tickers: ["COIN", "MARA", "RIOT", "CIFR", "CLSK", "IREN", "WULF"] },
  { name: "Industrial Electrification", tickers: ["ETN", "HUBB", "GEV", "PWR"] },
  { name: "Consumer / Travel", tickers: ["ABNB", "DASH", "RCL", "CCL", "BKNG"] },
  { name: "Yield / Defense Anchors", tickers: ["KO", "PEP", "JNJ", "XOM", "TLT", "SPY", "QQQ"] },
  {
    name: "Healthcare / Medical",
    tickers: [
      "LLY", "JNJ", "ABBV", "MRK", "PFE", "BMY", "VTRS", // pharma majors
      "AMGN", "GILD", "VRTX", "BIIB", "MRNA", "EXEL", "VKTX", // biotech
      "UNH", "ELV", "HUM", "CNC", "CVS", // managed care / payers
      "HCA", // providers
      "ABT", "MDT", "BSX", "DXCM", "EW", "ISRG", // medical devices
      "IQV", "ILMN", // life science tools / CRO
      "ZTS", // animal health
      "HIMS", // telehealth / GLP-1 adjacent
      "XLV", "XBI", "IBB", // ETFs
    ],
  },
];

export const SECTOR_CLUSTERS = RAW_CLUSTERS.map((c) => ({
  name: c.name,
  tickers: Array.from(new Set(c.tickers)).filter((t) => !DO_NOT_ADD.includes(t)),
}));

// Anything in the full universe that isn't in any named cluster above - shown as its own
// bucket so clicking through sectors never silently drops tickers that just don't have a
// clean theme (index ETFs, one-off industrials, etc.).
export const UNCLUSTERED = FULL_UNIVERSE.filter(
  (t) => !SECTOR_CLUSTERS.some((c) => c.tickers.includes(t)),
);

// Industry sectors — a second, complete classification (one bucket per ticker, not
// overlapping) covering all 194 names, unlike SECTOR_CLUSTERS above which follows the v7
// doc's investment-thesis groupings and only tags about half the universe. This is the
// literal "sort the whole list into industry buckets" categorization. Built by hand from
// general knowledge of each company's business, not pulled from a data provider - a few of
// the less-familiar names (CERT, HCAT, RDW, QS, FANUY, COHR) are reasonable best guesses,
// worth a sanity check rather than treated as authoritative.
const RAW_INDUSTRY_SECTORS: { name: string; tickers: string[] }[] = [
  {
    name: "Semiconductors & Equipment",
    tickers: ["AMAT", "AMBA", "AMD", "ADI", "ARM", "ASML", "AVGO", "CEVA", "COHR", "FORM", "INTC", "KLAC", "LRCX", "MCHP", "MPWR", "MRVL", "NVDA", "NXPI", "ON", "QCOM", "TER", "TSM", "TXN"],
  },
  {
    name: "Software & Cloud Platforms",
    tickers: ["ADBE", "ADSK", "AI", "ANSS", "APP", "BBAI", "CDNS", "CFLT", "CRM", "DDOG", "ESTC", "HCAT", "HUBS", "IBM", "INTU", "MDB", "NOW", "PATH", "PLTR", "SNOW", "SNPS", "SOUN", "TEAM"],
  },
  { name: "Cybersecurity", tickers: ["CRWD", "FTNT", "NET", "OKTA", "PANW", "S", "ZS"] },
  { name: "Data Center & Networking Hardware", tickers: ["ANET", "CIEN", "CRWV", "DELL", "PSTG", "SMCI", "STX", "WDC"] },
  { name: "Internet, Media & Telecom", tickers: ["BABA", "BIDU", "DIS", "GOOGL", "META", "NFLX", "T", "TCEHY", "TWLO", "VZ"] },
  { name: "Megacap Diversified Tech", tickers: ["AAPL", "AMZN", "MSFT", "ORCL"] },
  { name: "Fintech & Payments", tickers: ["AFRM", "HOOD", "NU", "PYPL", "SOFI", "SQ"] },
  { name: "E-Commerce, Travel & Rideshare", tickers: ["ABNB", "BKNG", "CCL", "CHWY", "DASH", "LYFT", "RCL", "SHOP", "UBER"] },
  { name: "Consumer Retail & Staples", tickers: ["COST", "KO", "NKE", "PEP", "SBUX", "TGT", "ULTA", "WMT"] },
  { name: "Autos & EV", tickers: ["F", "GM", "QS", "TSLA"] },
  { name: "Industrials, Automation & Machinery", tickers: ["ABB", "CGNX", "DE", "EMR", "ETN", "FANUY", "GE", "GEV", "HON", "HUBB", "JCI", "PWR", "ROK", "SYM", "VRT", "ZBRA"] },
  { name: "Aerospace, Defense & Space", tickers: ["ACHR", "ASTS", "AVAV", "BA", "JOBY", "LUNR", "RDW", "RKLB"] },
  { name: "Energy & Power Generation", tickers: ["CEG", "CVX", "ENPH", "OKLO", "PLUG", "RUN", "VST", "XOM"] },
  { name: "Materials & Agriculture", tickers: ["CF", "MOS"] },
  { name: "Real Estate / Data Center REITs", tickers: ["DLR", "EQIX"] },
  { name: "Crypto & Digital Assets", tickers: ["CIFR", "CLSK", "COIN", "IREN", "MARA", "MSTR", "RIOT", "WULF"] },
  { name: "Quantum Computing", tickers: ["IONQ", "RGTI"] },
  {
    name: "Healthcare & Life Sciences",
    tickers: [
      "ABBV", "ABT", "AMGN", "BIIB", "BMY", "BSX", "CERT", "CNC", "CVS", "DXCM", "ELV", "EW",
      "EXEL", "GILD", "HCA", "HIMS", "HUM", "IBB", "ILMN", "IQV", "ISRG", "JNJ", "LLY", "MDT",
      "MRK", "MRNA", "NTRA", "PFE", "RXRX", "SDGR", "TEM", "UNH", "VEEV", "VKTX", "VRTX", "VTRS", "XBI", "XLV", "ZTS",
    ],
  },
  { name: "Diversified / Macro ETFs", tickers: ["IWM", "QQQ", "SPY", "TLT"] },
  { name: "Airlines & Travel Transport", tickers: ["AAL", "DAL"] },
  { name: "Consulting & Business Services", tickers: ["BAH"] },
];

export const INDUSTRY_SECTORS = RAW_INDUSTRY_SECTORS.map((c) => ({
  name: c.name,
  tickers: Array.from(new Set(c.tickers)).filter((t) => !DO_NOT_ADD.includes(t)),
}));

// Full-universe names this hand-built classification missed - should be empty; kept as an
// explicit export (not silently dropped) so a future FULL_UNIVERSE edit that adds a new
// ticker surfaces here instead of that name just vanishing from every industry bucket.
export const INDUSTRY_UNCLASSIFIED = FULL_UNIVERSE.filter(
  (t) => !INDUSTRY_SECTORS.some((c) => c.tickers.includes(t)),
);
