// Pulls brokerage holdings for EVERY linked investment account through the
// local Plaid connection and writes a per-account snapshot for the CSP
// screener: public/positions-by-account.json
//
//   node scripts/refresh-positions-by-account.mjs
//
// This is the Muse side of the positions feed (see docs/positions-feed.md):
// Muse runs this from its own Plaid connection, then calls /api/screener once
// per account with that account's context (account, freeCash, reserved,
// positions) as query params. The app itself holds no tokens and never sees
// Muse's Plaid credentials.
//
// PRIVACY — READ BEFORE RUNNING: this repo is public, and
// public/positions-by-account.json is GITIGNORED (see .gitignore) for exactly
// that reason. Live account data is never committed here. Deploys ship the
// working-tree copy only if you deploy from a tree that has it; git-based
// deploys will not contain it, and the screener then behaves exactly as
// before (position-blind) unless the caller passes context as params.
//
// Exit code is always 0 so a cron can run it unattended. On Plaid failure it
// writes an honest "not linked" snapshot instead of failing.
//
// Plaid CLI resolution: $PLAID_BIN, else `plaid` on PATH, else the sandbox
// install at /opt/hatch/bin/plaid. The CLI prints JSON followed, on partial
// reads, by a trailing "Error: ..." line — parseFirstJson below reads only
// the first JSON document, so a failed institution (e.g. PayPal needing
// re-login) does not discard the good institutions' data.

import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public", "positions-by-account.json");
mkdirSync(join(ROOT, "public"), { recursive: true });

function plaidBin() {
  if (process.env.PLAID_BIN) return process.env.PLAID_BIN;
  try {
    execFileSync("which", ["plaid"], { encoding: "utf8" });
    return "plaid";
  } catch {
    return "/opt/hatch/bin/plaid";
  }
}

// Read the first JSON document out of CLI output that may carry a trailing
// non-JSON error line after it (partial reads). Brace-matching scanner that
// respects strings and escapes.
function parseFirstJson(text) {
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
  throw new Error("no complete JSON document in Plaid output");
}

function plaidJson(cmdArgs) {
  // NOTE: the CLI exits nonzero on partial reads (any institution failing)
  // while still printing the good institutions' JSON to stdout. execFileSync
  // would throw that output away, so use spawnSync and parse stdout
  // regardless of exit code — only fail when no JSON document is present.
  const res = spawnSync(plaidBin(), cmdArgs, { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
  const out = res.stdout || "";
  try {
    return parseFirstJson(out);
  } catch {
    const detail = (res.stderr || "").split("\n")[0].slice(0, 200);
    throw new Error(detail || `plaid ${cmdArgs.join(" ")} exited ${res.status} with no JSON output`);
  }
}

function notLinkedSnapshot(reason) {
  return {
    ok: false,
    as_of: new Date().toISOString(),
    source: "plaid",
    reason,
    action_needed:
      "Link the Fidelity brokerage account in Plaid (the Plaid add-account flow), then re-run scripts/refresh-positions-by-account.mjs.",
    accounts: [],
  };
}

// OCC root parse (fallback when the security has no option_contract block):
// root(1-6) + YYMMDD + C/P + strike*1000 (8 digits), e.g. META260123C00750000
function parseOcc(ticker) {
  const m = (ticker || "").toUpperCase().replace(/\s+/g, "").match(/^([A-Z]{1,6})(\d{6})([CP])(\d{8})$/);
  if (!m) return null;
  const [, root, yymmdd, cp, strikeRaw] = m;
  return {
    root,
    expiry: `20${yymmdd.slice(0, 2)}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`,
    right: cp === "C" ? "call" : "put",
    strike: Number(strikeRaw) / 1000,
  };
}

function optionDetail(sec) {
  // Prefer the structured contract block when Plaid provides it.
  const oc = sec.option_contract;
  if (oc && oc.expiration_date && oc.strike_price != null) {
    return {
      root: (oc.underlying_security_ticker || sec.ticker_symbol || "").replace(/[^A-Z]/g, "") || null,
      expiry: oc.expiration_date,
      right: oc.contract_type === "call" ? "call" : "put",
      strike: Number(oc.strike_price),
    };
  }
  const occ = parseOcc(sec.ticker_symbol || "");
  if (occ) return occ;
  // Name fallback: "META Jan 23 2026 $750 Call" style.
  const name = sec.name || "";
  const m = name.match(/([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4}).*?\$([\d.]+)\s*(call|put)/i);
  if (m) {
    const months = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
    const mon = months[m[1].toLowerCase()];
    if (mon) {
      return {
        root: (sec.ticker_symbol || "").replace(/[^A-Z]/g, "") || null,
        expiry: `${m[3]}-${mon}-${String(m[2]).padStart(2, "0")}`,
        right: m[5].toLowerCase(),
        strike: Number(m[4]),
      };
    }
  }
  return null;
}

function main() {
  let holdingsPayload;
  try {
    holdingsPayload = plaidJson(["investments-holdings"]);
  } catch (e) {
    const snap = notLinkedSnapshot(`plaid investments-holdings failed: ${e.message.split("\n")[0].slice(0, 200)}`);
    writeFileSync(OUT, JSON.stringify(snap, null, 2));
    console.log("wrote not-linked snapshot:", snap.reason);
    return;
  }
  const body = holdingsPayload.body || {};
  const accounts = (body.accounts || []).filter((a) => a.type === "investment");
  const holdings = body.holdings || [];
  const securities = new Map((body.securities || []).map((s) => [s.security_id, s]));

  // Institution names come from the accounts read (holdings body does not link
  // accounts to institutions). Best effort only — a missing name never blocks.
  const institutionByAccount = new Map();
  try {
    const accountsPayload = plaidJson(["accounts"]);
    for (const inst of accountsPayload.body?.institutions || []) {
      for (const a of inst.accounts || []) {
        institutionByAccount.set(a.account_id, inst.display_name || null);
      }
    }
  } catch {
    // Non-fatal: institution names stay null.
  }

  if (!accounts.length) {
    const snap = notLinkedSnapshot("No investment accounts found through Plaid.");
    writeFileSync(OUT, JSON.stringify(snap, null, 2));
    console.log("wrote not-linked snapshot:", snap.reason);
    return;
  }

  const failedInstitutions = (body.institutions || [])
    .filter((i) => i.ok === false)
    .map((i) => i.display_name)
    .filter(Boolean);

  const outAccounts = [];
  for (const account of accounts) {
    const acctHoldings = holdings.filter((h) => h.account_id === account.account_id);
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
      };
      if (type === "equity" || type === "etf") {
        positions.push({ ...base, kind: "stock" });
      } else if (type === "derivative" || type === "option") {
        const opt = optionDetail(sec);
        if (!opt) unparsed.push(sec.ticker_symbol || sec.name);
        positions.push({
          ...base,
          kind: opt ? opt.right : "option",
          // Screener-shape fields: the underlying ticker, not the OCC root string.
          ticker: opt?.root || base.symbol,
          strike: opt?.strike ?? null,
          expiry: opt?.expiry ?? null,
        });
      } else if (type === "cash" || type === "money market") {
        positions.push({ ...base, kind: "cash" });
      } else {
        positions.push({ ...base, kind: type || "other" });
      }
    }
    // Collateral already reserved by this account's short puts (strike x 100 x
    // contracts). This is allocated money, not free cash — the screener's
    // free-cash gate uses balances.available, and this figure is reported
    // alongside so a caller can sanity-check the two against each other.
    const reservedPutCapital = positions.reduce((sum, p) => {
      if (p.kind === "put" && p.side === "short" && p.strike) {
        return sum + p.strike * 100 * Math.abs(p.quantity);
      }
      return sum;
    }, 0);
    const balances = account.balances || {};
    outAccounts.push({
      account_name: account.name || account.official_name || "",
      account_mask: account.mask || "",
      institution: institutionByAccount.get(account.account_id) || null,
      total_value: balances.current ?? null,
      free_cash: balances.available ?? null,
      position_count: positions.filter((p) => p.kind !== "cash").length,
      reserved_put_capital: Math.round(reservedPutCapital * 100) / 100,
      positions,
      notes: unparsed.length ? [`Could not parse contract detail for: ${unparsed.join(", ")}`] : [],
    });
  }

  const priceAsOf =
    holdings.map((h) => h.institution_price_as_of).filter(Boolean).sort().pop() || null;
  const snap = {
    ok: true,
    as_of: new Date().toISOString(),
    source: "plaid",
    price_as_of: priceAsOf,
    partial_institutions_failed: failedInstitutions,
    accounts: outAccounts,
  };
  writeFileSync(OUT, JSON.stringify(snap, null, 2));
  for (const a of outAccounts) {
    console.log(
      `${a.account_name} (···${a.account_mask}): total $${a.total_value} free cash $${a.free_cash} reserved puts $${a.reserved_put_capital} positions ${a.position_count}`
    );
    // Ready-to-paste screener context for this account.
    const screenerPositions = a.positions
      .filter((p) => p.kind === "put" || p.kind === "call" || p.kind === "stock")
      .map((p) => ({
        ticker: p.kind === "stock" ? p.symbol : p.ticker,
        kind: p.kind,
        side: p.side,
        quantity: Math.abs(p.quantity),
        strike: p.strike ?? undefined,
        expiry: p.expiry ?? undefined,
        marketValue: p.kind === "stock" ? p.market_value : undefined,
      }));
    console.log(
      `  screener params: account=${encodeURIComponent(a.account_name)} accountValue=${a.total_value} freeCash=${a.free_cash} reserved=${a.reserved_put_capital} positions=${encodeURIComponent(JSON.stringify(screenerPositions))}`
    );
  }
}

main();
