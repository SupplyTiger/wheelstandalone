"""
wheel_constants.py — palette, typography, and static data constants.
Imported by every other Wheel module.  No logic, no I/O.

Palette v3 — DaisyUI "fantasy" theme inspired, Tailwind violet/emerald tokens.
"""
from datetime import date as _date

# ─── Palette ──────────────────────────────────────────────────────────────────
# Inspired by DaisyUI "fantasy" light theme + Tailwind violet/emerald scales.
#
#  Layer       Hex        Tailwind equiv      Use
#  ──────────────────────────────────────────────────────────────────────
#  bg          #f5f3ff    violet-50           Root window / deepest bg
#  bg2         #ffffff    white               Cards, panels, header
#  bg3         #ede9fe    violet-100          Elevated surface, rows
#  bg4         #ddd6fe    violet-200          Hover / selected state
#  border      #c4b5fd    violet-300          Subtle separator
#  border2     #7c3aed    violet-600          Card outline, accent border
#  ──────────────────────────────────────────────────────────────────────
#  text        #1e1b4b    indigo-950          Primary body text
#  text2       #4c1d95    violet-900          Secondary / label text
#  text3       #6d28d9    violet-700          Muted / placeholder text
#  ──────────────────────────────────────────────────────────────────────
#  green       #059669    emerald-600         Profit, bullish, success
#  grn2        #047857    emerald-700         Button hover
#  grn3        #d1fae5    emerald-100         Green tinted bg badge
#  ──────────────────────────────────────────────────────────────────────
#  red         #dc2626    red-600             Loss, bearish, danger
#  red2        #b91c1c    red-700             Button hover
#  red3        #fee2e2    red-100             Red tinted bg badge
#  ──────────────────────────────────────────────────────────────────────
#  amber       #d97706    amber-600           Warning, caution
#  amb3        #fef3c7    amber-100           Amber tinted bg badge
#  ──────────────────────────────────────────────────────────────────────
#  purp        #7c3aed    violet-600          AI / special features, primary
#  cyan        #0891b2    cyan-600            Info, links
#  white       #ffffff    white               High-contrast surfaces
#  ──────────────────────────────────────────────────────────────────────
#  nav_active  #ede9fe    violet-100          Active nav tab background
#  nav_accent  #7c3aed    violet-600          Active tab underline stripe
C = dict(
    bg          = '#f6f8fb',
    bg2         = '#ffffff',
    bg3         = '#eef2f7',
    bg4         = '#e6edf7',
    border      = '#d9e2ec',
    border2     = '#378ADD',
    # text — near-black indigo for primary; NEUTRAL grays for secondary/muted
    # (Word, Explorer, VS Code all use gray for secondary — not saturated color)
    text        = '#0a0a0a',   # primary
    text2       = '#525252',   # secondary
    text3       = '#a3a3a3',   # muted
    green       = '#27500A',
    grn2        = '#1f4308',
    grn3        = '#EAF3DE',
    red         = '#791F1F',
    red2        = '#641919',
    red3        = '#FCEBEB',
    amber       = '#633806',
    amb3        = '#FAEEDA',
    purp        = '#378ADD',
    cyan        = '#0C447C',
    white       = '#ffffff',
    accent      = '#378ADD',
    accent_light= '#B5D4F4',
    nav_active  = '#E6F1FB',
    nav_accent  = '#378ADD',
    row_even    = '#ffffff',
    row_odd     = '#f8fafc',
    row_sel     = '#E6F1FB',
)

# ─── Typography ───────────────────────────────────────────────────────────────
# Segoe UI  — Windows system font, designed for screen legibility
# Consolas  — Microsoft's purpose-built screen monospace for data/numbers
#
#  Token       Size  Weight   Use
#  ─────────────────────────────────────────────────────────
#  DISPLAY     20    bold     App name in header
#  HEAD        14    bold     Card titles, position symbols
#  LABEL       11    bold     Section labels, field caps
#  BODY        11    regular  Descriptions, verdict text
#  DATA        12    regular  Prices, tickers, percentages
#  DATA_SM     10    regular  Dates, metadata, small tags
#  NUM_BIG     22    bold     Hero wall values
#  NUM_MED     15    bold     Stat box numbers
#  NUM_SCORE   30    bold     Favorability score
#  ─────────────────────────────────────────────────────────

FONT_DISPLAY  = ('Segoe UI Semibold', 20, 'bold')
FONT_HEAD     = ('Segoe UI',  13, 'bold')   # 14→13: matches Word/Explorer heading density
FONT_LABEL    = ('Segoe UI',  10, 'bold')   # 11→10: Windows toolbar/label standard
FONT_BODY     = ('Segoe UI',  10)            # 11→10: Windows body text standard
FONT_DATA     = ('Consolas',  11)            # 12→11: tighter table cells
FONT_DATA_SM  = ('Consolas',   9)            # 10→9:  timestamps/captions
FONT_NUM_BIG  = ('Consolas',  22, 'bold')
FONT_NUM_MED  = ('Consolas',  15, 'bold')
FONT_NUM_SCORE= ('Consolas',  30, 'bold')

# Aliases so existing references keep working without a full rename sweep
FONT_TITLE    = FONT_LABEL
FONT_MONO     = FONT_DATA
FONT_MONO_SM  = FONT_DATA_SM
FONT_BIG      = FONT_NUM_BIG

# ─── Money market / cash-equivalent tickers ───────────────────────────────────
# ─── Money market / cash-equivalent tickers to exclude from positions ────────
# Fidelity parks uninvested cash in these funds. SnapTrade returns them as equity
# positions (e.g. SPAXX 128,556 shares @ $1.00), which doubles the cash balance
# and pollutes the position list. Strip them out before saving.
MONEY_MARKET_TICKERS = {
    'SPAXX','FDRXX','FZFXX','FZAXX','FDIC','FCASH',
    'VMFXX','VMMXX','VMRXX',   # Vanguard
    'SWVXX','SNVXX',           # Schwab
    'SGOV','BIL',              # T-bill ETFs sometimes parked as cash
}

# ─── Leveraged / dangerous ETFs — never hold if assigned ─────────────────────
LEVERAGED_ETFS = {
    'SOXL','TQQQ','SPXL','UVXY','LABU','NAIL','FNGU','WEBL','BULZ','HIBL',
    'TNA','FAS','TECL','RETL','DPST','DFEN','WANT','UPRO','UDOW','URTY',
    'NUGT','JNUG','BOIL','KOLD','GUSH','DRIP',
}

# ─── Earnings dates ───────────────────────────────────────────────────────────
# Format: 'TICKER': 'YYYY-MM-DD'  — keep updated each quarter
EARNINGS_DATES = {
    'META':  '2026-04-29',
}

GEO_SENSITIVE_BASE = {'SLV','GLD','USO','XOM','CVX','LMT','RTX','NOC','GDX','OIL','IAU','UCO'}

# ─── FOMC / CPI / PPI calendar ────────────────────────────────────────────────
# FOMC announcement dates 2026-2027 (Federal Reserve published schedule)
FOMC_DATES = [
    _date(2026,  1, 28), _date(2026,  3, 18), _date(2026,  5,  6),
    _date(2026,  6, 17), _date(2026,  7, 29), _date(2026,  9, 16),
    _date(2026, 10, 28), _date(2026, 12, 16),
    _date(2027,  1, 27), _date(2027,  3, 17), _date(2027,  5,  5),
    _date(2027,  6, 16), _date(2027,  7, 28), _date(2027,  9, 15),
    _date(2027, 10, 27), _date(2027, 12, 15),
]

_CPI_2026 = [_date(2026,m,d) for m,d in [
    (1,15),(2,12),(3,12),(4,9),(5,13),(6,11),(7,15),(8,12),(9,10),(10,15),(11,12),(12,10)]]
_PPI_2026 = [_date(2026,m,d) for m,d in [
    (1,14),(2,11),(3,11),(4,8),(5,12),(6,10),(7,14),(8,11),(9,9),(10,14),(11,11),(12,9)]]

# ─── Institutional fund universe ──────────────────────────────────────────────
FUND_UNIVERSE = [
    dict(name='Berkshire Hathaway',  abbr='BRK', cik='1067983',  max_pos=None),
    dict(name='Pershing Square',     abbr='PSQ', cik='1336528',  max_pos=None),
    dict(name='Baupost Group',       abbr='BAU', cik='886357',   max_pos=None),
    dict(name='Third Point',         abbr='3PT', cik='1040570',  max_pos=None),
    dict(name='Appaloosa Mgmt',      abbr='APP', cik='1656456',  max_pos=None),
    dict(name='ValueAct Capital',    abbr='VAC', cik='1076682',  max_pos=None),
    dict(name='Greenlight Capital',  abbr='GLC', cik='1079114',  max_pos=None),
    dict(name='Dodge & Cox',         abbr='D&C', cik='28049',    max_pos=50),
    dict(name='BlackRock',           abbr='BLK', cik='1364742',  max_pos=25),
]
