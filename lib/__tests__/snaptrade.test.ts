import { test } from "node:test";
import assert from "node:assert/strict";

import { signSnapTrade, last4, mapStockPosition, mapOptionPosition, mapBalances } from "../snaptrade";

test("signSnapTrade matches the Python/SDK reference signature", () => {
  // Reference computed with json.dumps(sort_keys=True, separators=(",", ":")) + HMAC-SHA256 + base64,
  // the same algorithm the desktop app and the official SDKs use.
  const sig = signSnapTrade(
    "test-consumer-key",
    "/accounts",
    "clientId=TEST-CLIENT&timestamp=1700000000&userId=u-1&userSecret=s3cr3t-abc",
  );
  assert.equal(sig, "+dIOcQWihKJqtggUpZLJiY5MsRDbjxXjEJ5qcMOFG+4=");
});

test("last4 masks account numbers", () => {
  assert.equal(last4("Z40455767"), "5767");
  assert.equal(last4(undefined), "????");
});

test("mapStockPosition reads units/price/cost and flags SPAXX as cash", () => {
  const p = mapStockPosition({
    symbol: { symbol: { symbol: "LUNR", raw_symbol: "LUNR" } },
    units: 500,
    price: 12,
    average_purchase_price: 10,
  });
  assert.equal(p.ticker, "LUNR");
  assert.equal(p.side, "long");
  assert.equal(p.marketValue, 6000);
  assert.equal(p.gainUsd, 1000);
  assert.equal(p.cashEquivalent, false);

  const cash = mapStockPosition({ symbol: { symbol: { symbol: "SPAXX" } }, units: 1000, price: 1 });
  assert.equal(cash.cashEquivalent, true);
});

test("mapOptionPosition handles a short put", () => {
  const o = mapOptionPosition(
    {
      symbol: {
        option_symbol: {
          underlying_symbol: { symbol: "IONQ" },
          option_type: "PUT",
          strike_price: 30,
          expiration_date: "2026-10-16",
          is_mini_option: false,
        },
      },
      units: -2,
      market_value: -120, // 2 contracts @ 0.60
      average_purchase_price: 150, // $1.50 per share premium
    },
    new Date("2026-09-23T14:00:00Z"),
  );
  assert.equal(o.ticker, "IONQ");
  assert.equal(o.type, "put");
  assert.equal(o.side, "short");
  assert.equal(o.contracts, 2);
  assert.equal(o.strike, 30);
  assert.equal(o.dte, 24);
  assert.ok(Math.abs((o.mark ?? 0) - 0.6) < 1e-9);
  assert.ok(Math.abs((o.gainUsd ?? 0) - 180) < 1e-9); // (1.50 - 0.60) * 2 * 100
  assert.ok(Math.abs((o.gainPct ?? 0) - 60) < 1e-9);
  assert.equal(o.markVerified, true);
});

test("mapBalances accepts array or object", () => {
  assert.deepEqual(mapBalances([{ currency: { code: "USD" }, cash: 5000, buying_power: 9000 }]), [
    { currency: "USD", cash: 5000, buyingPower: 9000 },
  ]);
  assert.equal(mapBalances(null).length, 0);
});
