"""
wheel_persistence.py — all JSON file I/O for The Wheel.
Handles history, watchlist, account, screener cache, settings, performance, etc.
"""
import os
import json as _json
import re as _re2
from datetime import datetime, timedelta

# ─── File paths ───────────────────────────────────────────────────────────────
_APP_DIR             = os.path.dirname(os.path.abspath(__file__))
_HISTORY_FILE        = os.path.join(_APP_DIR, 'max_pain_history.json')
_WATCHLIST_FILE      = os.path.join(_APP_DIR, 'watchlist.json')
_OI_BASELINE_FILE    = os.path.join(_APP_DIR, 'oi_baseline.json')
_13F_CACHE_FILE      = os.path.join(_APP_DIR, 'thirteenf_cache.json')
_SCREENER_CACHE_FILE = os.path.join(_APP_DIR, 'screener_cache.json')
_DISCOVERY_LOG_FILE  = os.path.join(_APP_DIR, 'discovery_log.json')
_ACCOUNT_FILE        = os.path.join(_APP_DIR, 'account.json')
_SETTINGS_FILE       = os.path.join(_APP_DIR, 'settings.json')
_PERF_FILE           = os.path.join(_APP_DIR, 'performance.json')
_SYNC_STATUS_FILE    = os.path.join(_APP_DIR, 'sync_status.json')
_ERROR_LOG_FILE      = os.path.join(_APP_DIR, 'error_log.txt')

def _safe_error_summary(exc_or_message, limit=180):
    text = str(exc_or_message or '').replace('\r', ' ').replace('\n', ' ').strip()
    text = _re2.sub(r'(?i)(token|secret|password|authorization|api[_-]?key)=\S+', r'\1=[redacted]', text)
    text = _re2.sub(r'(?i)(bearer\s+)[A-Za-z0-9._~+/=-]+', r'\1[redacted]', text)
    text = _re2.sub(r'[A-Za-z0-9._~+/=-]{32,}', '[redacted]', text)
    return text[:limit]

def _now_iso_minutes():
    return datetime.now().isoformat(timespec='minutes')

def _write_sync_status(status):
    try:
        with open(_SYNC_STATUS_FILE, 'w') as f:
            _json.dump(status, f, indent=2)
        return True
    except Exception:
        return False

def load_sync_status():
    try:
        with open(_SYNC_STATUS_FILE, 'r') as f:
            data = _json.load(f)
            return data if isinstance(data, dict) else {}
    except (FileNotFoundError, ValueError):
        return {}

def save_sync_status(status_dict):
    return _write_sync_status(dict(status_dict or {}))

def record_sync_attempt(source):
    status = load_sync_status()
    status.update({
        'last_sync_attempt': _now_iso_minutes(),
        'last_sync_source': str(source or 'unknown')[:40],
        'last_sync_status': 'ATTEMPTED',
        'last_sync_error': '',
    })
    return save_sync_status(status)

def record_sync_success(source, account_updated, position_count):
    status = load_sync_status()
    status.update({
        'last_sync_success': _now_iso_minutes(),
        'last_sync_source': str(source or 'unknown')[:40],
        'last_sync_status': 'SUCCESS',
        'last_sync_error': '',
        'account_json_updated': account_updated,
        'position_count': position_count,
    })
    return save_sync_status(status)

def record_sync_failure(source, error_message):
    status = load_sync_status()
    status.update({
        'last_sync_failure': _now_iso_minutes(),
        'last_sync_source': str(source or 'unknown')[:40],
        'last_sync_status': 'FAILED',
        'last_sync_error': _safe_error_summary(error_message),
    })
    return save_sync_status(status)

def record_sync_stale_after_attempt(source, account_updated):
    status = load_sync_status()
    status.update({
        'last_sync_failure': _now_iso_minutes(),
        'last_sync_source': str(source or 'unknown')[:40],
        'last_sync_status': 'STALE_AFTER_SYNC',
        'last_sync_error': 'account.json remained stale after sync attempt',
        'account_json_updated': account_updated,
    })
    return save_sync_status(status)

def record_balance_fields_status(source, status_value, error_message=''):
    status = load_sync_status()
    status.update({
        'last_sync_source': str(source or 'unknown')[:40],
        'balance_fields_status': str(status_value or 'UNKNOWN')[:40],
        'balance_fields_error': _safe_error_summary(error_message) if error_message else '',
    })
    return save_sync_status(status)

def _append_safe_error_log(message):
    try:
        with open(_ERROR_LOG_FILE, 'a') as f:
            f.write(f"{_now_iso_minutes()} {message}\n")
    except Exception:
        pass

# ─── Settings defaults ────────────────────────────────────────────────────────
_SETTINGS_DEFAULTS = dict(
    geo_risk            = False,
    geo_sensitive_extra = [],
    btc_red_below       = 50_000,
    btc_amber_below     = 80_000,
    btc_green_above     = 80_000,
    btc_risk_on_above   = 100_000,
    btc_moon_above      = 1_000_000,
    max_pct_per_pos     = 20,
    max_positions       = 10,
    monthly_target      = 4000,
)

# ─── Max Pain History ─────────────────────────────────────────────────────────
def load_history():
    try:
        with open(_HISTORY_FILE, 'r') as f:
            return _json.load(f)
    except (FileNotFoundError, ValueError):
        return {}

def save_history(data):
    try:
        with open(_HISTORY_FILE, 'w') as f:
            _json.dump(data, f, indent=2)
    except Exception:
        pass

def history_delta(history, ticker, expiry, current_mp):
    """Return (delta, prev_mp, days_ago) or (None, None, None) if no prior record."""
    prev = history.get(ticker, {}).get(expiry)
    if not prev:
        return None, None, None
    try:
        prev_mp   = float(prev['mp'])
        prev_dt   = datetime.fromisoformat(prev['ts'])
        days_ago  = max(0, (datetime.now() - prev_dt).days)
        delta     = current_mp - prev_mp
        return delta, prev_mp, days_ago
    except Exception:
        return None, None, None

def record_history(history, ticker, expiry, mp):
    """Write/overwrite the latest max pain value for ticker+expiry."""
    if ticker not in history:
        history[ticker] = {}
    history[ticker][expiry] = {
        'mp': mp,
        'ts': datetime.now().isoformat(timespec='minutes'),
    }

# ─── Watchlist ────────────────────────────────────────────────────────────────
def load_watchlist():
    try:
        with open(_WATCHLIST_FILE, 'r') as f:
            return _json.load(f)
    except (FileNotFoundError, ValueError):
        save_watchlist(list(WATCHLIST))
        return list(WATCHLIST)

def save_watchlist(tickers):
    try:
        with open(_WATCHLIST_FILE, 'w') as f:
            _json.dump(sorted(set(t.upper().strip() for t in tickers if t.strip())), f, indent=2)
    except Exception:
        pass

# ─── Fidelity text parser ─────────────────────────────────────────────────────
def parse_fidelity_text(text):
    """
    Parse text copied from a Fidelity Positions or Balances page — or OCR'd from a screenshot.
    Returns (positions_list, balance_float_or_None).

    Handles both the vertical "one field per line" layout Fidelity uses in its web app
    and the tab-separated table layout from copy-paste.
    """
    import re as _re2

    positions = []
    balance   = None

    # ── Balance ──────────────────────────────────────────────────────────────
    # e.g. "Account Value  $194,132.82"  /  "Total Account Value: $194,132.82"
    for bal_pat in [
        r'(?:total\s+)?(?:account|portfolio|net)\s*(?:account)?\s*value\s*[:\s\$]+\$?([\d,]+\.?\d*)',
        r'(?:cash\s+)?balance\s*[:\s\$]+\$?([\d,]+\.?\d*)',
    ]:
        m = _re2.search(bal_pat, text, _re2.IGNORECASE)
        if m:
            try:
                v = float(m.group(1).replace(',', ''))
                if v > 5_000:          # sanity: must look like a real balance
                    balance = v
                    break
            except ValueError:
                pass

    # ── Options ──────────────────────────────────────────────────────────────
    # Fidelity option symbol:  -SLV Apr 17 '26 $70.00 P   or  LUNR Apr 17 '26 $23 C
    OPT = _re2.compile(
        r'-?\s*([A-Z]{1,5})\s+'
        r'(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s*'
        r'(\d{1,2})\s*'
        r"'?(\d{2,4})\s*"
        r'\$?\s*([\d]+\.?\d*)\s*'
        r'\b([PC])\b',
        _re2.IGNORECASE
    )
    seen_opts = set()
    for m in OPT.finditer(text):
        ticker, mon, day, yr, strike_s, pc = m.groups()
        ticker = ticker.upper()
        key = (ticker, mon[:3].capitalize(), day, strike_s, pc.upper())
        if key in seen_opts:
            continue
        seen_opts.add(key)
        kind    = 'put' if pc.upper() == 'P' else 'call'
        yr_full = int(yr) + (2000 if int(yr) < 100 else 0)
        expiry  = f"{mon[:3].capitalize()} {int(day)}, {yr_full}"
        strike  = float(strike_s)
        seg_lines = text[m.start(): m.start() + 600].splitlines()

        # In Fidelity's vertical layout the qty appears as a bare integer on its own line
        # (after the symbol line + optional "Sell Put" / "Sell Call" description line).
        # Price appears as "$X.XX" on the following line.
        qty = 1; price = 0.0
        qty_line_idx = -1
        for j, ln in enumerate(seg_lines[1:], 1):   # skip symbol line
            ln = ln.strip()
            if _re2.match(r'^\d{1,4}$', ln):
                v = int(ln)
                if 1 <= v <= 500:
                    qty = v; qty_line_idx = j; break
        if qty_line_idx >= 0:
            for ln in seg_lines[qty_line_idx + 1:]:
                ln = ln.strip()
                pm = _re2.match(r'^\$?([\d,]+\.\d{2})$', ln)
                if pm:
                    v = float(pm.group(1).replace(',', ''))
                    if 0.0 < v <= 500.0:
                        price = v; break
        # Tab-separated fallback: "$X.XX" after the option symbol on the same line area
        if price == 0.0:
            seg = '\n'.join(seg_lines[:6])
            for pm in _re2.finditer(r'\$\s*([\d,]+\.\d{2})', seg):
                v = float(pm.group(1).replace(',', ''))
                if 0.0 < v <= 500.0 and v != strike:
                    price = v; break

        # Total gain — pattern: -$3,569.03 (-174.87%)
        seg      = '\n'.join(seg_lines)   # rejoin for gain search
        gain_usd = gain_pct = 0.0
        gm = _re2.search(r'(-?\$[\d,]+\.\d{2})\s*\((-?[\d.]+)%\)', seg)
        if gm:
            try:
                gain_usd = float(gm.group(1).replace('$', '').replace(',', ''))
                gain_pct = float(gm.group(2))
            except ValueError:
                pass

        sym = f"{ticker} {strike:.0f} {kind.capitalize()} — {mon[:3].capitalize()} {int(day)}"
        is_short = text[max(0, m.start() - 3):m.start()].strip().startswith("-")
        positions.append(dict(symbol=sym, ticker=ticker, kind=kind,
                              side='short' if is_short else 'long',
                              is_short=bool(is_short),
                              strike=strike, expiry=expiry, qty=qty,
                              price=price, gain_pct=gain_pct, gain_usd=gain_usd))

    # ── Stocks ───────────────────────────────────────────────────────────────
    # Fidelity vertical layout: TICKER alone on a line, then qty like "1,000", then "$62.70"
    # Skip tickers already covered by options
    opt_tickers = {p['ticker'] for p in positions}
    IGNORE_WORDS = {'AM','PM','PC','ON','AS','AT','OR','IT','BE','IS','IN','BY','NO',
                    'TO','DO','GO','MY','US','AN','OF','IF','OK','ID','AI','SP','QQ'}
    lines = [l.strip() for l in text.splitlines()]
    i = 0
    seen_stocks = set()
    while i < len(lines):
        line = lines[i]
        sm = _re2.match(r'^-?([A-Z]{2,5})$', line)
        if sm:
            ticker = sm.group(1)
            if ticker not in IGNORE_WORDS and ticker not in seen_stocks:
                seg = '\n'.join(lines[i: i + 12])
                # qty: pattern "1,000" or plain integer
                qm = _re2.search(r'\b([\d]{1,3}(?:,\d{3})*)\b', seg)
                pm = _re2.search(r'\$([\d,]+\.\d{2})', seg)
                if qm and pm:
                    try:
                        qty   = int(qm.group(1).replace(',', ''))
                        price = float(pm.group(1).replace(',', ''))
                        if 1 <= qty <= 1_000_000 and 0.01 <= price <= 100_000:
                            gain_usd = gain_pct = 0.0
                            gm2 = _re2.search(r'(-?\$[\d,]+\.\d{2})\s*\((-?[\d.]+)%\)', seg)
                            if gm2:
                                gain_usd = float(gm2.group(1).replace('$', '').replace(',', ''))
                                gain_pct = float(gm2.group(2))
                            seen_stocks.add(ticker)
                            positions.append(dict(
                                symbol =f"{ticker} — {qty:,} shares",
                                ticker =ticker, kind='stock',
                                strike =price,  expiry='Stock',
                                qty    =qty,    price=price,
                                avg_cost=price,
                                gain_pct=gain_pct, gain_usd=gain_usd,
                            ))
                    except ValueError:
                        pass
        i += 1

    return positions, balance

# ─── Screener cache ───────────────────────────────────────────────────────────
def load_screener_cache():
    try:
        with open(_SCREENER_CACHE_FILE, 'r', encoding='utf-8-sig') as f:
            data = _json.load(f)
        return data if isinstance(data, dict) else {}
    except (FileNotFoundError, ValueError):
        return {}

def save_screener_cache(results, metadata=None):
    """Save top screener results (sorted by ROI) for Morning Briefing."""
    try:
        top = sorted(results, key=lambda r: r.get('Raw ROI %', 0), reverse=True)[:20]
        payload = {
            'updated': datetime.now().isoformat(timespec='minutes'),
            'results': top,
        }
        if metadata is not None:
            payload['metadata'] = dict(metadata or {})
        with open(_SCREENER_CACHE_FILE, 'w', encoding='utf-8') as f:
            _json.dump(payload, f, indent=2)
        return True
    except Exception:
        return False

def load_account_data():
    """Return saved account dict or {} if not found."""
    try:
        with open(_ACCOUNT_FILE, 'r', encoding='utf-8-sig') as f:
            data = _json.load(f)
        return data if isinstance(data, dict) else {}
    except (FileNotFoundError, ValueError):
        return {}

def save_account_data(balance, floor, positions, balance_meta=None):
    """Persist balance, floor and positions list to account.json."""
    meta = dict(balance_meta or {})
    total_value = meta.get('total_value', balance)
    broker_total_value = meta.get('broker_total_value', total_value)
    balance_source = meta.get('balance_source', 'legacy.account.balance')
    balance_quality = meta.get('balance_quality', 'TOTAL_VALUE_ONLY')
    balance_warning = meta.get(
        'balance_warning',
        'Cash/buying power not available from current account cache; do not treat total value as cash capacity.'
    )
    try:
        with open(_ACCOUNT_FILE, 'w') as f:
            _json.dump({
                'balance': balance,
                'total_value': total_value,
                'broker_total_value': broker_total_value,
                'cash': meta.get('cash'),
                'buying_power': meta.get('buying_power'),
                'available_to_withdraw': meta.get('available_to_withdraw'),
                'available_to_trade': meta.get('available_to_trade'),
                'cash_secured_put_capacity': meta.get('cash_secured_put_capacity'),
                'balances_source': meta.get('balances_source'),
                'balances_quality': meta.get('balances_quality'),
                'balances_warning': meta.get('balances_warning'),
                'balance_source': balance_source,
                'balance_quality': balance_quality,
                'balance_warning': balance_warning,
                'floor': floor,
                'positions': positions,
                'updated': datetime.now().isoformat(timespec='minutes'),
            }, f, indent=2)
        return True
    except Exception:
        _append_safe_error_log('save_account_data failed: unable to write account.json')
        return False

# ─── Discovery log ────────────────────────────────────────────────────────────
def load_discovery_log():
    try:
        with open(_DISCOVERY_LOG_FILE, 'r') as f:
            return _json.load(f)
    except (FileNotFoundError, ValueError):
        return []

def log_watchlist_additions(tickers, source='manual'):
    """Append newly-added tickers to the discovery log (kept for 30 days)."""
    try:
        log   = load_discovery_log()
        today = datetime.now().strftime('%Y-%m-%d')
        cutoff = (datetime.now() - timedelta(days=30)).strftime('%Y-%m-%d')
        log   = [e for e in log if e.get('date', '') >= cutoff]   # prune old
        for t in tickers:
            log.append({'ticker': t.upper(), 'date': today, 'source': source})
        with open(_DISCOVERY_LOG_FILE, 'w') as f:
            _json.dump(log, f, indent=2)
    except Exception:
        pass

# ─── Settings ────────────────────────────────────────────────────────────────
def load_settings():
    s = dict(_SETTINGS_DEFAULTS)
    try:
        with open(_SETTINGS_FILE, 'r') as f:
            s.update(_json.load(f))
    except (FileNotFoundError, ValueError):
        pass
    return s

def save_settings(d):
    try:
        with open(_SETTINGS_FILE, 'w') as f:
            _json.dump(d, f, indent=2)
    except Exception:
        pass

# ─── OI baseline ─────────────────────────────────────────────────────────────
def load_oi_baseline():
    try:
        with open(_OI_BASELINE_FILE, 'r') as f:
            return _json.load(f)
    except (FileNotFoundError, ValueError):
        return {}

def save_oi_baseline(data):
    try:
        with open(_OI_BASELINE_FILE, 'w') as f:
            _json.dump(data, f, indent=2)
    except Exception:
        pass

def load_13f_cache():
    try:
        with open(_13F_CACHE_FILE, 'r') as f:
            return _json.load(f)
    except (FileNotFoundError, ValueError):
        return {}

def save_13f_cache(data):
    try:
        with open(_13F_CACHE_FILE, 'w') as f:
            _json.dump(data, f, indent=2)
    except Exception:
        pass

# ─── 13F cache ───────────────────────────────────────────────────────────────
def load_13f_cache():
    try:
        with open(_13F_CACHE_FILE, 'r') as f:
            return _json.load(f)
    except (FileNotFoundError, ValueError):
        return {}

def save_13f_cache(data):
    try:
        with open(_13F_CACHE_FILE, 'w') as f:
            _json.dump(data, f, indent=2)
    except Exception:
        pass

# ─── Performance log ─────────────────────────────────────────────────────────
def load_performance():
    try:
        with open(_PERF_FILE, 'r') as f:
            return _json.load(f)
    except (FileNotFoundError, ValueError):
        return {'trades': [], 'monthly_target': 4000}

def save_performance(data):
    try:
        with open(_PERF_FILE, 'w') as f:
            _json.dump(data, f, indent=2)
    except Exception:
        pass

# ─── Trade history source status ─────────────────────────────────────────────
_TRADE_SOURCE_FILE = os.path.join(_APP_DIR, 'trade_source_status.json')

def load_trade_source_status():
    try:
        with open(_TRADE_SOURCE_FILE, 'r') as f:
            return _json.load(f)
    except (FileNotFoundError, ValueError):
        return {}

def save_trade_source_status(data):
    try:
        with open(_TRADE_SOURCE_FILE, 'w') as f:
            _json.dump(dict(data or {}), f, indent=2)
    except Exception:
        pass

# ─── Discovery run status ────────────────────────────────────────────────────
_DISCOVERY_RUN_STATUS_FILE = os.path.join(_APP_DIR, 'discovery_run_status.json')

_DISCOVERY_RUN_STATUS_DEFAULT = {
    "status": "NOT_RUN",
    "ts": None,
    "rows": 0,
    "source": "SEC EDGAR 13F institutional holdings",
    "error": "",
}

def load_discovery_run_status():
    try:
        with open(_DISCOVERY_RUN_STATUS_FILE, 'r') as f:
            return _json.load(f)
    except (FileNotFoundError, ValueError):
        return dict(_DISCOVERY_RUN_STATUS_DEFAULT)

def save_discovery_run_status(data):
    try:
        with open(_DISCOVERY_RUN_STATUS_FILE, 'w') as f:
            _json.dump(dict(data or {}), f, indent=2)
    except Exception:
        pass
