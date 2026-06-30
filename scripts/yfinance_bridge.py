#!/usr/bin/env python3
"""JSON bridge for the Next.js API routes to read market data through yfinance."""
from __future__ import annotations

import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _clean_number(value: Any) -> float | int | None:
    if value is None:
        return None
    try:
        if math.isnan(value):
            return None
    except TypeError:
        pass
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _quality(value: Any) -> str:
    text = str(value or "").upper()
    if text in {"VERIFIED_FAST_INFO", "VERIFIED_INFO"}:
        return "VERIFIED"
    if text.startswith("FALLBACK"):
        return "FALLBACK"
    return "MISSING"


def _quote(ticker: str) -> dict[str, Any]:
    from wheel_market import get_quote_snapshot

    snapshot = get_quote_snapshot(ticker)
    price = _clean_number(snapshot.get("price"))
    previous_close = _clean_number(snapshot.get("previous_close"))
    change = _clean_number(snapshot.get("chg"))
    change_pct = _clean_number(snapshot.get("chg_pct"))
    return {
        "ticker": ticker,
        "price": price,
        "previousClose": previous_close,
        "change": change,
        "changePct": change_pct,
        "source": snapshot.get("quote_source") or "yfinance",
        "quality": _quality(snapshot.get("quote_quality")),
        "timestamp": snapshot.get("quote_timestamp") or datetime.now(timezone.utc).isoformat(),
    }


def _unix_from_expiry(expiry: str) -> int:
    dt = datetime.strptime(expiry, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    return int(dt.timestamp())


def _dte(expiry: str) -> int:
    today = datetime.now(timezone.utc).date()
    exp = datetime.strptime(expiry, "%Y-%m-%d").date()
    return max(0, (exp - today).days)


def _expiry_from_arg(expiries: tuple[str, ...], expiry_arg: str | None) -> str | None:
    if not expiries:
        return None
    if not expiry_arg:
        return expiries[0]
    expiry_arg = str(expiry_arg).strip()
    if expiry_arg in expiries:
        return expiry_arg
    if expiry_arg.isdigit():
        target = datetime.fromtimestamp(int(expiry_arg), tz=timezone.utc).date().isoformat()
        if target in expiries:
            return target
    return expiries[0]


def _selected_expiries(expiries: tuple[str, ...], expiry_arg: str | None, dte_min: int, dte_max: int) -> list[str]:
    if not expiries:
        return []
    if expiry_arg:
        selected = _expiry_from_arg(expiries, expiry_arg)
        return [selected] if selected else []

    dte_pairs = [(_dte(expiry), expiry) for expiry in expiries]
    future = [(dte, expiry) for dte, expiry in dte_pairs if dte > 0]
    valid = [expiry for dte, expiry in future if dte_min <= dte <= dte_max]
    if valid:
        return valid[:8]
    return [min(future or dte_pairs, key=lambda item: item[0])[1]]


def _option(row: Any, kind: str, expiry: str) -> dict[str, Any] | None:
    contract_symbol = row.get("contractSymbol")
    strike = _clean_number(row.get("strike"))
    if not contract_symbol or strike is None:
        return None
    open_interest = _clean_number(row.get("openInterest"))
    volume = _clean_number(row.get("volume"))
    return {
        "contractSymbol": str(contract_symbol),
        "strike": strike,
        "expiry": expiry,
        "kind": kind,
        "bid": _clean_number(row.get("bid")),
        "ask": _clean_number(row.get("ask")),
        "lastPrice": _clean_number(row.get("lastPrice")),
        "openInterest": int(open_interest or 0),
        "volume": int(volume or 0),
        "impliedVolatility": _clean_number(row.get("impliedVolatility")),
    }


def _technicals(stock: Any, price: float | int | None) -> dict[str, Any]:
    if price is None:
        return {}
    try:
        from wheel_market import calc_technicals

        return calc_technicals(stock, float(price)) or {}
    except Exception:
        return {}


def snapshot(ticker: str, expiry_arg: str | None = None, dte_min: int = 7, dte_max: int = 60) -> dict[str, Any]:
    import yfinance as yf

    ticker = str(ticker or "").upper().strip()
    stock = yf.Ticker(ticker)
    expiries = tuple(stock.options or ())
    selected_expiries = _selected_expiries(expiries, expiry_arg, dte_min, dte_max)
    options: list[dict[str, Any]] = []

    for selected_expiry in selected_expiries:
        chain = stock.option_chain(selected_expiry)
        for _, row in chain.calls.iterrows():
            option = _option(row, "call", selected_expiry)
            if option:
                options.append(option)
        for _, row in chain.puts.iterrows():
            option = _option(row, "put", selected_expiry)
            if option:
                options.append(option)

    quote = _quote(ticker)
    return {
        "ticker": ticker,
        "quote": quote,
        "technicals": _technicals(stock, quote.get("price")),
        "expirations": [
            {"unix": _unix_from_expiry(expiry), "date": expiry}
            for expiry in expiries
        ],
        "selectedExpiry": selected_expiries[0] if selected_expiries else None,
        "selectedExpiries": selected_expiries,
        "options": options,
    }


def main() -> int:
    if len(sys.argv) < 3 or sys.argv[1] != "snapshot":
        print("Usage: yfinance_bridge.py snapshot TICKER [EXPIRY]", file=sys.stderr)
        return 2
    data = snapshot(
        sys.argv[2],
        sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] != "-" else None,
        int(sys.argv[4]) if len(sys.argv) > 4 else 7,
        int(sys.argv[5]) if len(sys.argv) > 5 else 60,
    )
    print(json.dumps(data, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
