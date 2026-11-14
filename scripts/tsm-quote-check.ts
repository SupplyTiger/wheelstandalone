import { fetchOptionsSummary } from "../lib/yahooMarket";

async function main() {
  const s = await fetchOptionsSummary("TSM", "2027-01-15", "2027-01-21");
  console.log("underlying:", s.underlyingPrice, "dayChangePct:", s.dayChangePct);
  const hit = s.contractsList.filter(
    (c) => c.kind === "call" && c.strike === 480 && c.expiry === "2027-01-21"
  );
  if (!hit.length) {
    console.log("NO 480C 2027-01-21 found; nearby calls:");
    for (const c of s.contractsList.filter((c) => c.kind === "call" && c.expiry === "2027-01-21").slice(0, 8)) {
      console.log(c.expiry, c.strike, "bid", c.bid, "ask", c.ask, "last", c.last, "vol", c.volume, "iv", c.impliedVolatility);
    }
  } else {
    for (const c of hit) console.log("TSM 480C Jan21'27 ->", JSON.stringify(c));
  }
}
main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
