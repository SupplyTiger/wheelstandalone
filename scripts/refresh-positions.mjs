// Pulls brokerage holdings through the local Plaid connection and writes a
// normalized snapshot for the Positions tab: public/positions-live.json
//
//   node scripts/refresh-positions.mjs            # auto-pick the investment account
//   node scripts/refresh-positions.mjs --account "Prime Printer"   # match by name fragment
//
// Exit code is always 0 so a cron can run it unattended. When no investment
// account is linked (or Plaid errors), the script writes an honest "not linked"
// snapshot instead of failing - the UI renders that state instead of numbers.
//
// Fidelity's account number is NOT used for matching: Plaid only exposes masked
// digits. Match by institution display name + account name fragment instead.

import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public", "positions-live.json");
mkdirSync(join(ROOT, "public"), { recursive: true });

const args = process.argv.slice(2);
const nameFilter = args.includes("--account") ? args[args.indexOf("--account") + 1] : null;

function plaidJson(cmdArgs) {
  // NOTE (2026-10-24): the CLI exits nonzero on partial reads (any institution
  // failing) while still printing the good institutions' JSON to stdout, plus
  // a trailing "Error: ..." line. execFileSync + JSON.parse threw that output
  // away; parse only the first JSON document instead (same approach as
  // refresh-positions-by-account.mjs).
  const res = spawnSync("plaid", cmdArgs, { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
  const text = res.stdout || "";
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (start === -1) {
      if (ch === "{" || ch === "[") {
        start = i;
        depth = 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  const detail = (res.stderr || "").toString().split("\n")[0].slice(0, 200);
  throw new Error(detail || `plaid ${cmdArgs.join(" ")} exited ${res.status} with no JSON output`);
}

function notLinkedSnapshot(reason) {
  return {
    ok: false,
    as_of: new Date().toISOString(),
    source: "plaid",
    reason,
    action_needed:
      "Link the Fidelity brokerage account in Plaid (the Plaid add-account flow), then re-run scripts/refresh-positions.mjs.",
    account_summary: null,
    positions: [],
  };
}

// Best-effort option contract parse. Plaid derivative securities usually carry
// the OCC-style root in ticker_symbol and details in the name; fall back to
// parsing the name. Returns null when it can't be parsed - the position still
// shows, just without strike/expiry detail.
function parseOption(sec) {
  const ticker = (sec.ticker_symbol || "").toUpperCase().replace(/\s+/g, "");
  const name = sec.name || "";
  // OCC: root(1-6) + YYMMDD + C/P + strike*1000 (8 digits), e.g. META260123C00750000
  let m = ticker.match(/^([A-Z]{1,6})(\d{6})([CP])(\d{8})$/);
  if (m) {
    const [, root, yymmdd, cp, strikeRaw] = m;
    const yy = 2000 + Number(yymmdd.slice(0, 2));
    return {
      root,
      expiry: `${yy}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`,
      right: cp === "C" ? "call" : "put",
      strike: Number(strikeRaw) / 1000,
    };
  }
  // Name fallback: "META Jan 23 2026 $750 Call" style
  m = name.match(/([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4}).*?\$([\d.]+)\s*(call|put)/i);
  if (m) {
    const months = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
    const mon = months[m[1].toLowerCase()];
    if (mon) {
      return {
        root: ticker.replace(/[^A-Z]/g, "") || null,
        expiry: `${m[3]}-${mon}-${String(m[2]).padStart(2, "0")}`,
        right: m[5].toLowerCase(),
        strike: Number(m[4]),
      };
    }
  }
  return null;
}

function main() {
  let payload;
  try {
    payload = plaidJson(["investments-holdings"]);
  } catch (e) {
    const snap = notLinkedSnapshot(`plaid investments-holdings failed: ${e.message.split("\n")[0]}`);
    writeFileSync(OUT, JSON.stringify(snap, null, 2));
    console.log("wrote not-linked snapshot:", snap.reason);
    return;
  }

  const body = payload.body || {};
  const accounts = (body.accounts || []).filter((a) => a.type === "investment");
  const holdings = body.holdings || [];
  const securities = new Map((body.securities || []).map((s) => [s.security_id, s]));
  const institutions = body.institutions || [];

  if (!accounts.length || !holdings.length) {
    const snap = notLinkedSnapshot(
      "No investment accounts with holdings found through Plaid. Linked institutions: " +
        (institutions.map((i) => i.display_name).filter(Boolean).join(", ") || "none")
    );
    writeFileSync(OUT, JSON.stringify(snap, null, 2));
    console.log("wrote not-linked snapshot:", snap.reason);
    return;
  }

  let account = accounts[0];
  if (nameFilter) {
    const hit = accounts.find((a) =>
      `${a.name || ""} ${a.official_name || ""}`.toLowerCase().includes(nameFilter.toLowerCase())
    );
    if (hit) account = hit;
    else console.log(`--account "${nameFilter}" matched nothing; using ${account.name}`);
  }
  const acctHoldings = holdings.filter((h) => h.account_id === account.account_id);
  const institution = institutions.find((i) => i.credential_id === account._plaid_source?.credential_id);

  const positions = [];
  const unparsed = [];
  for (const h of acctHoldings) {
    const sec = securities.get(h.security_id) || {};
    const type = (sec.type || "").toLowerCase();
    const qty = Number(h.quantity) || 0;
    const mv = h.institution_value != null ? Number(h.institution_value) : null;
    const cb = h.cost_basis != null ? Number(h.cost_basis) : null;
    const base = {
      symbol: sec.ticker_symbol || sec.name || "UNKNOWN",
      name: sec.name || "",
      quantity: qty,
      side: qty < 0 ? "short" : "long",
      cost_basis: cb,
      market_value: mv,
      unrealized: cb != null && mv != null ? mv - cb : null,
      price_as_of: body.institution_price_as_of || body.retrieved_at || null,
    };
    if (type === "equity" || type === "etf") {
      positions.push({ ...base, kind: "stock" });
    } else if (type === "derivative" || type === "option") {
      const opt = parseOption(sec);
      if (!opt) unparsed.push(sec.ticker_symbol || sec.name);
      positions.push({ ...base, kind: opt ? opt.right : "option", option: opt });
    } else if (type === "cash" || type === "money market") {
      positions.push({ ...base, kind: "cash" });
    } else {
      positions.push({ ...base, kind: type || "other" });
    }
  }

  const equity = positions.reduce((s, p) => s + (p.market_value || 0), 0);
  const snap = {
    ok: true,
    as_of: new Date().toISOString(),
    source: "plaid",
    institution: institution?.display_name || "brokerage",
    account_name: account.name || account.official_name || "",
    account_mask: account.mask || "",
    price_as_of: body.institution_price_as_of || null,
    account_summary: {
      equity: Math.round(equity * 100) / 100,
      position_count: positions.filter((p) => p.kind !== "cash").length,
    },
    positions,
    notes: unparsed.length ? [`Could not parse contract detail for: ${unparsed.join(", ")}`] : [],
  };
  writeFileSync(OUT, JSON.stringify(snap, null, 2));
  console.log(
    `wrote ${positions.length} positions, equity ${snap.account_summary.equity}, as of ${snap.as_of}`
  );
}

main();
