"""
wheel_market.py — market intelligence: signals, FOMC/CPI/PPI calendar,
EDGAR 13F fetching, IV rank, technical indicators, and candidate scoring.
"""
import urllib.request as _urllib_req
import xml.etree.ElementTree as _ET
import re as _re
import json as _json
import time as _time
from datetime import datetime, timedelta, date as _date

from wheel_constants import (
    FOMC_DATES, _CPI_2026, _PPI_2026,
    GEO_SENSITIVE_BASE, EARNINGS_DATES,
    FUND_UNIVERSE,
)
from wheel_persistence import load_settings

_EDGAR_UA = {'User-Agent': 'TheWheelApp ryan@supplytiger.com'}
QUOTE_VERIFIED_QUALITIES = {'VERIFIED_FAST_INFO', 'VERIFIED_INFO'}
QUOTE_FRESHNESS_MINUTES = 90


def _quote_num(value):
    try:
        if value is None or value == "":
            return None
        return float(value)
    except Exception:
        return None


def _fast_value(fast_info, *names):
    for name in names:
        value = None
        try:
            value = fast_info.get(name)
        except Exception:
            try:
                value = fast_info[name]
            except Exception:
                value = None
        if value is None:
            try:
                value = getattr(fast_info, name)
            except Exception:
                value = None
        value = _quote_num(value)
        if value is not None and value > 0:
            return value
    return None


def parse_quote_timestamp(value):
    """Return a datetime for app-generated quote timestamps, or None."""
    text = str(value or '').strip()
    if not text:
        return None
    if text.endswith('Z'):
        text = text[:-1] + '+00:00'
    try:
        dt = datetime.fromisoformat(text)
        if dt.tzinfo is not None:
            dt = dt.astimezone().replace(tzinfo=None)
        return dt
    except Exception:
        pass
    for fmt in ('%Y-%m-%dT%H:%M', '%Y-%m-%dT%H:%M:%S', '%Y-%m-%d %H:%M'):
        try:
            return datetime.strptime(text[:len(fmt)], fmt)
        except Exception:
            pass
    return None


def quote_age_minutes(snapshot_or_row, now=None):
    data = snapshot_or_row or {}
    ts = parse_quote_timestamp(data.get('quote_timestamp') or data.get('Quote Timestamp'))
    if ts is None:
        return None
    now = now or datetime.now()
    return max(0.0, (now - ts).total_seconds() / 60.0)


def quote_is_fresh(snapshot_or_row, max_age_minutes=QUOTE_FRESHNESS_MINUTES, now=None):
    age = quote_age_minutes(snapshot_or_row, now=now)
    return age is not None and age <= max_age_minutes


def quote_quality_is_verified(snapshot_or_row):
    data = snapshot_or_row or {}
    quality = str(data.get('quote_quality') or data.get('Quote Quality') or '').upper().strip()
    return quality in QUOTE_VERIFIED_QUALITIES


def quote_is_verified_fresh(snapshot_or_row, max_age_minutes=QUOTE_FRESHNESS_MINUTES, now=None):
    return quote_quality_is_verified(snapshot_or_row) and quote_is_fresh(
        snapshot_or_row,
        max_age_minutes=max_age_minutes,
        now=now,
    )


def quote_rule6_status(snapshot_or_row, max_age_minutes=QUOTE_FRESHNESS_MINUTES, now=None):
    data = snapshot_or_row or {}
    if not quote_is_verified_fresh(data, max_age_minutes=max_age_minutes, now=now):
        return 'UNKNOWN'
    chg = _quote_num(data.get('chg_pct'))
    if chg is None:
        chg = _quote_num(data.get('Underlying Chg %') or data.get('Chg%'))
    if chg is None:
        return 'UNKNOWN'
    return 'RED' if chg < 0 else 'GREEN'


def quote_debug_lines(ticker):
    snapshot = get_quote_snapshot(ticker)
    rule6 = quote_rule6_status(snapshot)

    def fmt_money(value):
        n = _quote_num(value)
        return '-' if n is None else f'{n:.2f}'

    def fmt_pct(value):
        n = _quote_num(value)
        return '-' if n is None else f'{n:+.2f}%'

    return [
        f"Ticker: {str(ticker or '').upper().strip()}",
        f"Price: {fmt_money(snapshot.get('price'))}",
        f"Previous Close: {fmt_money(snapshot.get('previous_close'))}",
        f"Change %: {fmt_pct(snapshot.get('chg_pct'))}",
        f"Quote Source: {snapshot.get('quote_source') or '-'}",
        f"Quote Quality: {snapshot.get('quote_quality') or 'MISSING'}",
        f"Timestamp: {snapshot.get('quote_timestamp') or '-'}",
        f"Rule 6 status: {rule6}",
        'No trade placed. Ryan approval required.',
    ]


def get_quote_snapshot(ticker):
    """
    Return a safe quote snapshot for screener price/change use.

    yfinance daily history is a fallback only because it can be stale intraday.
    """
    snapshot = {
        'price': None,
        'previous_close': None,
        'chg': None,
        'chg_pct': None,
        'quote_source': None,
        'quote_timestamp': datetime.now().isoformat(timespec='minutes'),
        'quote_quality': 'MISSING',
    }
    ticker = str(ticker or '').upper().strip()
    if not ticker:
        return snapshot

    try:
        import yfinance as yf
    except Exception:
        return snapshot

    try:
        stock = yf.Ticker(ticker)
    except Exception:
        return snapshot

    def finish(price, previous_close, source, quality):
        price = _quote_num(price)
        previous_close = _quote_num(previous_close)
        snapshot.update(
            price=price,
            previous_close=previous_close,
            quote_source=source,
            quote_quality=quality,
        )
        if price is not None and previous_close is not None and previous_close > 0:
            snapshot['chg'] = price - previous_close
            snapshot['chg_pct'] = (price - previous_close) / previous_close * 100
        return snapshot

    try:
        fast = getattr(stock, 'fast_info', None)
        price = _fast_value(fast, 'last_price', 'lastPrice', 'regular_market_price')
        previous_close = _fast_value(fast, 'previous_close', 'previousClose', 'regular_market_previous_close')
        if price is not None and previous_close is not None:
            return finish(price, previous_close, 'yfinance.fast_info', 'VERIFIED_FAST_INFO')
    except Exception:
        pass

    try:
        info = stock.info or {}
        price = _quote_num(info.get('regularMarketPrice') or info.get('currentPrice'))
        previous_close = _quote_num(info.get('previousClose') or info.get('regularMarketPreviousClose'))
        if price is not None and previous_close is not None:
            return finish(price, previous_close, 'yfinance.info', 'VERIFIED_INFO')
    except Exception:
        pass

    try:
        hist = stock.history(period='5d', interval='1d')
        if hist is not None and not hist.empty:
            price = _quote_num(hist['Close'].iloc[-1])
            previous_close = _quote_num(hist['Close'].iloc[-2]) if len(hist) >= 2 else None
            if price is not None:
                return finish(price, previous_close, 'yfinance.history_5d_1d', 'FALLBACK_HISTORY_UNVERIFIED')
    except Exception:
        pass

    return snapshot

# ─── Geo-sensitive set ────────────────────────────────────────────────────────
def geo_sensitive_set():
    extra = load_settings().get('geo_sensitive_extra', [])
    return GEO_SENSITIVE_BASE | {t.upper() for t in extra}

# ─── Market intelligence: date-math helpers ───────────────────────────────────
def _first_friday(year, month):
    """Return the first Friday of the given month."""
    for d in range(1, 8):
        if _date(year, month, d).weekday() == 4:
            return _date(year, month, d)

def _third_friday(year, month):
    """Return the third Friday (OPEX) of the given month."""
    count = 0
    for d in range(1, 32):
        try:
            if _date(year, month, d).weekday() == 4:
                count += 1
                if count == 3:
                    return _date(year, month, d)
        except ValueError:
            break

def get_nfp_dates(months_ahead=3):
    """First Friday of each upcoming month = NFP release day."""
    today = datetime.now().date()
    dates = []
    y, m = today.year, today.month
    for _ in range(months_ahead + 1):
        d = _first_friday(y, m)
        if d and d >= today:
            dates.append(d)
        m += 1
        if m > 12: m, y = 1, y + 1
    return dates

def get_upcoming_econ_events(days_ahead=14):
    today = datetime.now().date()
    cutoff = today + timedelta(days=days_ahead)
    events = []
    for d in _CPI_2026:
        if today <= d <= cutoff: events.append(('CPI', d))
    for d in _PPI_2026:
        if today <= d <= cutoff: events.append(('PPI', d))
    for d in get_nfp_dates():
        if today <= d <= cutoff: events.append(('NFP', d))
    return sorted(events, key=lambda x: x[1])

def get_next_fomc():
    today = datetime.now().date()
    future = [d for d in FOMC_DATES if d >= today]
    if not future: return None, None
    nxt = min(future)
    return nxt, (nxt - today).days

def get_seasonal_signal():
    m = datetime.now().month
    if m == 9:
        return 'SEP  historically worst', 'red', 0
    elif m in (5, 6, 7, 8):
        return 'MAY-OCT  weak window', 'amber', 1
    elif m == 10:
        return 'OCT  season turning', 'amber', 2
    elif m in (11, 12, 1, 2):
        return 'NOV-FEB  strong season', 'green', 3
    else:
        return 'MAR-APR  neutral', 'green', 2

def is_opex_week():
    today = datetime.now().date()
    opex = _third_friday(today.year, today.month)
    if not opex: return False, None
    week_start = opex - timedelta(days=4)
    return week_start <= today <= opex, opex

def calc_composite_signal(vix_pts, seasonal_pts, dxy_pts, econ_pts):
    """
    Four factors, each scored, sum = 1-10.
      vix_pts:      1-3  (higher VIX = better premium, more pts)
      seasonal_pts: 0-3
      dxy_pts:      0-2  (stable/falling = better)
      econ_pts:     0-2  (no events = better)
    """
    raw = vix_pts + seasonal_pts + dxy_pts + econ_pts
    return max(1, min(10, raw))

def vix_to_signal(vix):
    """Returns (label, color_key, pts) for a given VIX level."""
    if vix < 15:   return f'VIX {vix:.1f}  LOW — poor premium', 'green', 1
    elif vix < 25: return f'VIX {vix:.1f}  NORMAL',              'amber', 2
    else:          return f'VIX {vix:.1f}  ELEVATED — sell!',    'red',   3

def dxy_to_signal(dxy, week_chg_pct):
    """Returns (label, color_key, pts)."""
    arrow = '↑' if week_chg_pct > 0 else '↓'
    chg   = abs(week_chg_pct)
    if week_chg_pct > 1.0:
        return f'DXY {dxy:.1f} {arrow}  strong rise', 'red',   0
    elif week_chg_pct > 0:
        return f'DXY {dxy:.1f} {arrow}  rising',      'amber', 1
    else:
        return f'DXY {dxy:.1f} {arrow}  stable/fall', 'green', 2

def btc_to_signal(btc, settings):
    """Returns (label, color_key) using configurable thresholds."""
    if btc >= settings['btc_moon_above']:
        return f'BTC ${btc/1e6:.2f}M  🚀 MOON',          'green'
    elif btc >= settings['btc_risk_on_above']:
        return f'BTC ${btc/1000:.0f}K  RISK-ON ✓',       'green'
    elif btc >= settings['btc_green_above']:
        return f'BTC ${btc/1000:.0f}K  healthy',         'green'
    elif btc >= settings['btc_amber_below']:
        return f'BTC ${btc/1000:.0f}K  caution',         'amber'
    else:
        return f'BTC ${btc/1000:.0f}K  RISK-OFF ✕',      'red'

# ─── Watchlist load (proxy — real load in wheel_persistence) ──────────────────
# (wheel_market needs load_watchlist for btc_to_signal — it's imported via star
#  in the_wheel.py; here we just re-export the signal helpers.)

# ─── 13F / EDGAR ─────────────────────────────────────────────────────────────
def fetch_13f_tickers(cik, max_pos=None):
    """
    Pull the latest 13F-HR filing from SEC EDGAR for the given CIK.
    Returns list of dicts: {ticker, name, value_k, rank}
    Writes step-by-step diagnostics to discovery_debug.log.
    """
    import os as _os
    _log_path = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)),
                               'discovery_debug.log')
    def _flog(msg):
        try:
            with open(_log_path, 'a') as _f:
                _f.write(f'  [{cik}] {msg}\n')
        except Exception:
            pass

    try:
        # Step 1 — find latest 13F-HR accession number
        url = f'https://data.sec.gov/submissions/CIK{int(cik):010d}.json'
        req = _urllib_req.Request(url, headers=_EDGAR_UA)
        with _urllib_req.urlopen(req, timeout=12) as r:
            sub = _json.loads(r.read())
        filings = sub.get('filings', {}).get('recent', {})
        forms   = filings.get('form', [])
        accs    = filings.get('accessionNumber', [])
        latest  = next((a for f, a in zip(forms, accs) if f in ('13F-HR', '13F-HR/A')), None)
        if not latest:
            _flog('SKIP: no 13F-HR found in filings list')
            return []
        _flog(f'latest 13F: {latest}')

        # Step 2 — get the filing document index
        nodash  = latest.replace('-', '')
        idx_url = f'https://www.sec.gov/Archives/edgar/data/{cik}/{nodash}/{latest}-index.json'
        req = _urllib_req.Request(idx_url, headers=_EDGAR_UA)
        with _urllib_req.urlopen(req, timeout=12) as r:
            idx = _json.loads(r.read())

        # Find the information table XML — try multiple patterns
        xml_name = None
        for doc in idx.get('documents', []):
            n = doc.get('name', '').lower()
            if 'infotable' in n and n.endswith('.xml'):
                xml_name = doc['name']; break
        if not xml_name:
            for doc in idx.get('documents', []):
                n = doc.get('name', '').lower()
                if n.endswith('.xml') and 'primary' not in n and 'xslt' not in n:
                    xml_name = doc['name']; break
        if not xml_name:
            # last resort: any xml
            for doc in idx.get('documents', []):
                if doc.get('name', '').lower().endswith('.xml'):
                    xml_name = doc['name']; break
        if not xml_name:
            all_names = [d.get('name','') for d in idx.get('documents', [])]
            _flog(f'SKIP: no XML found in index. Docs: {all_names}')
            return []
        _flog(f'xml file: {xml_name}')

        # Step 3 — parse the information table XML
        xml_url = f'https://www.sec.gov/Archives/edgar/data/{cik}/{nodash}/{xml_name}'
        req = _urllib_req.Request(xml_url, headers=_EDGAR_UA)
        with _urllib_req.urlopen(req, timeout=15) as r:
            raw = r.read()

        root = _ET.fromstring(raw)
        # Try multiple namespace variants used by different filers
        _ns_variants = [
            {'ns': 'http://www.sec.gov/edgar/document/thirteenf/informationtable'},
            {'ns': 'http://www.sec.gov/edgar/thirteenf/informationtable'},
            {},
        ]
        nodes = []
        for _nsv in _ns_variants:
            if _nsv:
                nodes = root.findall('.//ns:infoTable', _nsv)
            else:
                # No namespace — try bare tag search
                nodes = root.findall('.//infoTable')
                if not nodes:
                    # Strip namespace from all tags and retry
                    import re as _re2
                    for el in root.iter():
                        el.tag = _re2.sub(r'\{.*?\}', '', el.tag)
                    nodes = root.findall('.//infoTable')
            if nodes:
                break

        _flog(f'XML parsed: {len(nodes)} infoTable rows')

        def _txt(el, tag, ns=None):
            for t in (f'ns:{tag}' if ns else tag, tag):
                try:
                    v = el.find(t, ns) if ns else el.find(tag)
                    if v is not None and v.text:
                        return v.text.strip()
                except Exception:
                    pass
            return None

        rows = []
        for n in nodes:
            nm  = _txt(n, 'nameOfIssuer')
            csp = _txt(n, 'cusip')
            val = _txt(n, 'value')
            if nm and val:
                try:
                    rows.append(dict(name=nm, cusip=csp or '', value_k=int(val)))
                except ValueError:
                    pass

        _flog(f'{len(rows)} holdings parsed')
        rows.sort(key=lambda x: x['value_k'], reverse=True)
        if max_pos:
            rows = rows[:max_pos]

        # Step 4 — resolve CUSIPs → tickers via OpenFIGI (free, no key)
        cusips     = [r['cusip'] for r in rows if r['cusip']]
        _flog(f'{len(cusips)} CUSIPs to resolve')
        ticker_map = _cusips_to_tickers(cusips, _log_path)

        result = []
        for rank, row in enumerate(rows, 1):
            t = ticker_map.get(row['cusip'], '').upper().strip()
            if t:
                result.append(dict(ticker=t, name=row['name'],
                                   value_k=row['value_k'], rank=rank))
        _flog(f'{len(result)} tickers resolved from {len(rows)} holdings')
        return result

    except Exception as _e:
        import traceback as _tb
        try:
            with open(_log_path, 'a') as _f:
                _f.write(f'  [{cik}] EXCEPTION: {_e}\n')
                _f.write(_tb.format_exc() + '\n')
        except Exception:
            pass
        return []

def _cusips_to_tickers(cusips, log_path=None):
    """OpenFIGI bulk CUSIP→ticker lookup. Free, no key, 25 req/min rate limit."""
    import time as _t

    def _flog(msg):
        if not log_path: return
        try:
            with open(log_path, 'a') as _f:
                _f.write(f'    [OpenFIGI] {msg}\n')
        except Exception:
            pass

    if not cusips:
        return {}
    result = {}
    # US exchange codes — broad set to avoid missing valid tickers
    _US_CODES = {'US', 'UN', 'UW', 'UA', 'UR', 'UQ', 'UP', 'UO', 'UE', 'UD', 'UF'}

    for i in range(0, len(cusips), 100):
        batch = cusips[i:i + 100]
        jobs  = [{'idType': 'ID_CUSIP', 'idValue': c} for c in batch]
        data  = _json.dumps(jobs).encode()
        req   = _urllib_req.Request(
            'https://api.openfigi.com/v3/mapping', data=data,
            headers={'User-Agent': _EDGAR_UA['User-Agent'],
                     'Content-Type': 'application/json'})
        try:
            with _urllib_req.urlopen(req, timeout=20) as r:
                raw      = r.read()
                status   = r.getcode()
            _flog(f'batch {i//100+1}: HTTP {status}, {len(batch)} CUSIPs')
            mapping = _json.loads(raw)
            resolved = 0
            for cusip, entry in zip(batch, mapping):
                if entry.get('error'):
                    continue
                items = entry.get('data') or []
                # Prefer recognised US exchange code
                for item in items:
                    if item.get('exchCode', '') in _US_CODES:
                        t = item.get('ticker', '').strip()
                        if t:
                            result[cusip] = t
                            resolved += 1
                            break
                # Fallback: use first available ticker regardless of exchange
                if cusip not in result and items:
                    t = items[0].get('ticker', '').strip()
                    if t:
                        result[cusip] = t
                        resolved += 1
            _flog(f'  → {resolved}/{len(batch)} resolved')
        except Exception as _e:
            _flog(f'batch {i//100+1} FAILED: {_e}')
        _t.sleep(2.5)   # respect OpenFIGI 25 req/min
    return result

def fetch_universe_tickers():
    """
    Scrape S&P 500 + Nasdaq-100 constituent tickers from Wikipedia.
    Returns a set of ticker strings. Falls back to empty set on error.
    """
    tickers = set()
    sources = [
        ('https://en.wikipedia.org/wiki/List_of_S%26P_500_companies',   r'id="constituents"'),
        ('https://en.wikipedia.org/wiki/Nasdaq-100',                     r'id="constituents"'),
    ]
    for url, table_id in sources:
        try:
            req = _urllib_req.Request(url, headers=_EDGAR_UA)
            with _urllib_req.urlopen(req, timeout=12) as r:
                html = r.read().decode('utf-8', errors='ignore')
            m = _re.search(table_id + r'.*?</table>', html, _re.S)
            if m:
                # Pull ticker-like text from first <td> of each <tr>
                rows = _re.findall(r'<tr[^>]*>(.*?)</tr>', m.group(), _re.S)
                for row in rows[1:]:
                    cells = _re.findall(r'<td[^>]*>(.*?)</td>', row, _re.S)
                    if cells:
                        raw = _re.sub(r'<[^>]+>', '', cells[0]).strip()
                        raw = raw.replace('\n', '').replace('.', '-')
                        if _re.match(r'^[A-Z]{1,5}(-[A-Z])?$', raw):
                            tickers.add(raw)
        except Exception:
            pass
    return tickers

# ─── Technical indicator helpers ─────────────────────────────────────────────
def calc_iv_rank(stock):
    """
    Approximate IV rank (0–100) using 21-day rolling realised-vol percentile
    over the past year. Higher = more expensive premium environment.
    Returns None on failure.
    """
    try:
        hist = stock.history(period='1y')
        if len(hist) < 60:
            return None
        rv = hist['Close'].pct_change().dropna().rolling(21).std() * (252 ** 0.5) * 100
        rv = rv.dropna()
        if len(rv) < 2:
            return None
        lo, hi = rv.min(), rv.max()
        if hi == lo:
            return 50.0
        return round((rv.iloc[-1] - lo) / (hi - lo) * 100, 1)
    except Exception:
        return None

# ─── Technical indicator helpers ─────────────────────────────────────────────

def calc_technicals(stock, price):
    """
    Returns dict with:
      dma200, dma50, rsi14, week52_hi, week52_lo,
      pct_from_200, pct_from_50,
      golden_cross (bool), death_cross (bool),
      dma_signal ('green'|'amber'|'red'),
      rsi_signal ('green'|'amber'|'red'),
      wk52_signal ('green'|'amber'),
    All values may be None on failure.
    """
    result = dict(dma200=None, dma50=None, rsi14=None,
                  week52_hi=None, week52_lo=None,
                  pct_from_200=None, pct_from_50=None,
                  golden_cross=False, death_cross=False,
                  dma_signal='gray', rsi_signal='gray', wk52_signal='gray')
    try:
        hist = stock.history(period='1y')
        if len(hist) < 50:
            return result
        closes = hist['Close']

        # 200/50 DMA
        dma200 = float(closes.tail(200).mean()) if len(closes) >= 200 else float(closes.mean())
        dma50  = float(closes.tail(50).mean())
        result.update(dma200=round(dma200, 2), dma50=round(dma50, 2))

        # % distance from DMAs
        pct200 = (price - dma200) / dma200 * 100
        pct50  = (price - dma50)  / dma50  * 100
        result.update(pct_from_200=round(pct200, 1), pct_from_50=round(pct50, 1))

        # 200 DMA signal
        if price < dma200:
            result['dma_signal'] = 'red'
        elif abs(pct200) <= 5:
            result['dma_signal'] = 'amber'
        else:
            result['dma_signal'] = 'green'

        # Golden / death cross (50 DMA vs 200 DMA, recent 10-day window)
        if len(closes) >= 210:
            old_dma50  = float(closes.iloc[-210:-160].mean())
            old_dma200 = float(closes.iloc[-210:].head(200).mean())
            result['golden_cross'] = (old_dma50 < old_dma200) and (dma50 > dma200)
            result['death_cross']  = (old_dma50 > old_dma200) and (dma50 < dma200)

        # RSI-14
        delta  = closes.diff().dropna()
        gain   = delta.clip(lower=0).rolling(14).mean()
        loss   = (-delta.clip(upper=0)).rolling(14).mean()
        rs     = gain / loss.replace(0, float('nan'))
        rsi    = 100 - (100 / (1 + rs))
        rsi14  = float(rsi.dropna().iloc[-1]) if not rsi.dropna().empty else None
        result['rsi14'] = round(rsi14, 1) if rsi14 is not None else None
        if rsi14 is not None:
            if rsi14 > 70:
                result['rsi_signal'] = 'red'    # overbought — risky to sell puts
            elif rsi14 <= 50:
                result['rsi_signal'] = 'green'  # ideal entry zone
            else:
                result['rsi_signal'] = 'amber'

        # 52-week hi/lo
        hi52 = float(closes.max()); lo52 = float(closes.min())
        result.update(week52_hi=round(hi52, 2), week52_lo=round(lo52, 2))
        # Closer to 52-week low = better put entry
        rng = hi52 - lo52
        if rng > 0:
            pos_in_range = (price - lo52) / rng   # 0 = at low, 1 = at high
            result['wk52_signal'] = 'green' if pos_in_range < 0.4 else \
                                    'amber' if pos_in_range < 0.7 else 'red'
            result['wk52_pos'] = round(pos_in_range * 100, 0)
        else:
            result['wk52_pos'] = 50
    except Exception:
        pass
    return result

def score_candidate(
    price,
    iv_rank,
    fund_hits,
    account,
    max_pct,
    rsi=None,
    wk52_pos=None,
    chg_pct=None,
    ann_roi=None,
    spread_pct=None,
    open_interest=None,
    option_volume=None,
    event_flag=False,
    earnings_flag=False,
):
    """
    Conservative v2 composite score 0-100 for a Wheel candidate.
    Returns None if the position is unaffordable given current account settings.
    """
    max_strike = account * (max_pct / 100)
    if price > max_strike:
        return None

    def _num(value, default=None):
        try:
            if value is None:
                return default
            return float(value)
        except Exception:
            return default

    score = 0.0

    # 1) IV rank / volatility proxy: 0-25
    ivr = _num(iv_rank)
    if ivr is not None:
        if ivr <= 20:
            score += 0
        elif ivr >= 70:
            score += 25
        else:
            score += (ivr - 20) * (25.0 / 50.0)

    # 2) Execution quality: 0-20
    sp = _num(spread_pct)
    if sp is not None:
        if sp <= 5:
            score += 10
        elif sp <= 10:
            score += 7
        elif sp <= 15:
            score += 3

    oi = _num(open_interest, 0) or 0
    if oi >= 500:
        score += 5
    elif oi >= 100:
        score += 3
    elif oi > 0:
        score += 1

    vol = _num(option_volume, 0) or 0
    if vol >= 100:
        score += 5
    elif vol >= 25:
        score += 3
    elif vol > 0:
        score += 1

    # 3) 52-week position / trend regime: 0-20
    pos = _num(wk52_pos)
    if pos is not None:
        if pos <= 20:
            score += 0
        elif pos <= 40:
            score += 8
        elif pos <= 70:
            score += 20
        elif pos <= 85:
            score += 12
        else:
            score += 6

    # 4) Annualized ROI: 0-15
    ann = _num(ann_roi)
    if ann is not None:
        if 10 <= ann < 20:
            score += 4
        elif 20 <= ann < 35:
            score += 8
        elif 35 <= ann < 75:
            score += 15
        elif 75 <= ann <= 100:
            score += 8
        elif ann > 100:
            score += 3

    # 5) Red-day context: 0-10
    chg = _num(chg_pct)
    if chg is not None:
        if chg <= -3:
            score += 10
        elif chg <= -2:
            score += 8
        elif chg <= -1:
            score += 6
        elif chg < 0:
            score += 3

    # 6) RSI: 0-7
    rsi_v = _num(rsi)
    if rsi_v is not None:
        if rsi_v <= 20:
            score += 2
        elif rsi_v <= 30:
            score += 5
        elif rsi_v <= 55:
            score += 7
        elif rsi_v <= 70:
            score += max(0, 7 - ((rsi_v - 55) / 15.0) * 5)

    # 7) Fund hits: 0-3
    try:
        score += min(3, len(fund_hits))
    except Exception:
        pass

    # Penalties
    if event_flag:
        score -= 5
    if earnings_flag:
        score -= 10
    if sp is not None and sp > 20:
        score -= 10
    if ann is not None and ann > 150:
        score -= 10
    if pos is not None and pos <= 15:
        score -= 10

    return round(max(0, min(100, score)))


def _debug_quote_main(argv=None):
    import argparse
    parser = argparse.ArgumentParser(description='Safe quote snapshot diagnostic.')
    parser.add_argument('--debug-quote', metavar='TICKER', help='Print safe quote fields for one ticker.')
    args = parser.parse_args(argv)
    if args.debug_quote:
        print('\n'.join(quote_debug_lines(args.debug_quote)))
        return 0
    parser.print_help()
    return 0


if __name__ == '__main__':
    raise SystemExit(_debug_quote_main())
