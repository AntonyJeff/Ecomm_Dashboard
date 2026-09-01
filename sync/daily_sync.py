"""
Daily Salesforce -> Google Sheets sync for the CLG dashboard.
Full refresh every run: clears sheet and rewrites Jan 1 2026 -> yesterday.
Captures status changes (MQL, SQL promotions) on older leads automatically.
Intended to run via GitHub Actions every day at 3 AM IST (21:30 UTC previous day).
"""

import ssl
import warnings
import os
import requests
import pandas as pd
from datetime import datetime, timedelta, timezone
import gspread
from google.oauth2.service_account import Credentials
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env.local'))

# Keep SSL bypass consistent with existing scripts
ssl._create_default_https_context = ssl._create_unverified_context
try:
    import urllib3
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
except ImportError:
    pass
warnings.filterwarnings('ignore', message='Unverified HTTPS request')

# -- Date range: fixed start (campaign launch) -> yesterday dynamic ------------
yesterday  = datetime.now(timezone.utc) - timedelta(days=1)
START_DATE = '2026-01-01T00:00:00Z'
END_DATE   = yesterday.strftime('%Y-%m-%dT23:59:59Z')
DATE_LABEL = yesterday.strftime('%Y-%m-%d')

# The regional "qualified Ecomm lead" reports are scoped to the current
# fiscal year (Apr 1 -> Mar 31, matching "Current FY" in the report UI), not
# the calendar-year START_DATE above. This needs updating by hand each April.
FY_START_DATE = '2026-04-01T00:00:00Z'
FY_START_DATE_ONLY = '2026-04-01'
DATE_LABEL_ONLY = DATE_LABEL  # already YYYY-MM-DD, alias for clarity below

# SOQL date literals are type-strict: DateTime fields (only CreatedDate here)
# need the full 'YYYY-MM-DDThh:mm:ssZ' quoteless literal; every stage
# milestone field (Meeting_Booked_Date__c, Meeting_Executed_Date__c,
# SQL_Change_Date__c) is a plain Date field and needs a bare 'YYYY-MM-DD'
# literal instead -- mixing the two formats is a SOQL parse error either way.
DATETIME_FIELDS = {'CreatedDate'}

# -- Channel scope: Paid (LinkedIn, Facebook, Factors, Influ2 -- Google Ads
# skipped for now) + Organic (Website, Webinar, Email, WhatsApp, LinkedIn
# Download, ABM). Verified against the live LeadSource / Sub_Lead_Source_
# Category__c picklists on both Lead and Opportunity via Salesforce schema.
LEAD_SOURCE_VALUES = [
    'ABM', 'Growth Marketing', 'Inbound Lead', 'ABM Safal Imperia',
    'Insent', 'Intercom', 'Factors Engaged', 'Influ 2 Engaged',
]
SUB_SOURCE_VALUES = [
    'Website / SEO', 'Webinar', 'Email Marketing', 'ABM',
    'LinkedIn Demo', 'LinkedIn Download', 'Google Ads',
    'Influ2 Download', 'Influ2 Demo', 'Webinar Demo', 'Facebook',
    'Webinar Attended', 'Email Demo', 'WhatsApp', 'Factors Engaged',
]


def soql_in(values):
    escaped = [v.replace("'", "\\'") for v in values]
    return '(' + ', '.join(f"'{v}'" for v in escaped) + ')'


def soql_contains_terms(field, values):
    """field LIKE '%v1%' OR field LIKE '%v2%' OR ... (no outer parens -- the
    caller composes these). SOQL's LIKE is case-insensitive, matching the
    report-builder "contains" operator."""
    escaped = [v.replace("'", "\\'").replace('%', '\\%').replace('_', '\\_') for v in values]
    return ' OR '.join(f"{field} LIKE '%{v}%'" for v in escaped)


def soql_not_contains_all(field, values):
    """(NOT field LIKE '%v1%') AND (NOT field LIKE '%v2%') ... -- excludes rows
    containing ANY of the given substrings. SOQL's NOT must be the sole
    operator inside its own parens -- 'NOT x AND NOT y' in one group is a
    parse error, each NOT needs its own parens."""
    escaped = [v.replace("'", "\\'").replace('%', '\\%').replace('_', '\\_') for v in values]
    return ' AND '.join(f"(NOT {field} LIKE '%{v}%')" for v in escaped)


LEAD_SOURCE_IN = soql_in(LEAD_SOURCE_VALUES)
SUB_SOURCE_IN = soql_in(SUB_SOURCE_VALUES)

# -- Per-region "qualified Ecomm lead" filters, mirroring the exact filter
# logic from the report builder (field numbers referenced in code comments
# match the numbering in the original screenshots). Structure genuinely
# differs by region (EU has no Country filter and adds Owner_Sub_Team__c
# instead), so each region gets its own WHERE clause rather than one
# shared/parameterized query.
VERTICAL_MAIN_VALUES = ['ecomm', 'retail', 'E-Comm', 'd2c', 'lifestyle', 'fmcg']
VERTICAL_INDUSTRY_VALUES = [
    'ecomm', 'Ecommerce', 'FMCG', 'Retail', 'Consumer Durables',
    'D2C - Website', 'D2C', 'E-Comm/D2C', 'Lifestyle',
]
# NOTE: "Industry Vertical" in the report UI is the STANDARD `Industry` field,
# not the custom `Industry_Vertical__c` field -- this org has two fields with
# the same label. Confirmed by matching the EU report's total (232) and its
# exact Sub_Lead_Source_Category__c breakdown record-for-record.
VERTICAL_CLAUSE = '(' + soql_contains_terms('Main_Industry_Vertical__c', VERTICAL_MAIN_VALUES) \
    + ' OR ' + soql_contains_terms('Industry', VERTICAL_INDUSTRY_VALUES) + ')'  # (3 OR 4) in India/SEA; (2 OR 3) in EU

EU_LEAD_SOURCE_VALUES = [
    'ABM', 'Growth Marketing', 'Inbound Lead', 'SDR Generated', 'Sales Generated',
    'Partner Generated', 'ABM Safal Imperia', 'Event', 'Start-up Campaign',
    'LinkedIn Sales Navigator', 'US ABM', 'Email - PMM', 'Insent', 'Intercom',
    'US SEM', 'EmailDojo', 'BDR Generated', 'Social', 'Digital Agency',
    'Partner Co-Marketing', 'Field Campaign', 'Agentic CMO', 'Inbound SDR',
    'Digital', 'Factors Engaged', 'Influ 2 Engaged',
]

# NOTE: the report UI's "Country" filter is `Country_Picklist__c`, not the
# standard `Country` field -- this org has SEVEN fields with "country" in the
# name/label. Confirmed by matching the India report's total (173) and its
# exact Sub_Lead_Source_Category__c breakdown record-for-record.
REGION_LEAD_FILTERS = {
    'India': {
        'sheet': 'india_ecomm_lead',
        # (1 OR 5) AND 2 AND (3 OR 4) AND 6
        'where': lambda: (
            f"(LeadSource IN {soql_in(['ABM', 'Growth Marketing', 'Inbound Lead', 'ABM Safal Imperia', 'Insent', 'Intercom', 'Factors Engaged', 'Influ 2 Engaged'])} "
            f"OR Attendee_Source__c = 'ABM') "
            f"AND Country_Picklist__c = 'India' "
            f"AND {VERTICAL_CLAUSE} "
            f"AND {soql_not_contains_all('Source__c', ['dimi'])}"
        ),
    },
    'SEA': {
        'sheet': 'sea_ecomm_lead',
        # (1 OR 5) AND 2 AND (3 OR 4) AND 6
        'where': lambda: (
            f"(LeadSource IN {soql_in(['ABM', 'Growth Marketing', 'Inbound Lead', 'ABM Safal Imperia', 'Insent', 'Intercom', 'Digital', 'Factors Engaged', 'Influ 2 Engaged'])} "
            f"OR Attendee_Source__c = 'ABM') "
            f"AND Country_Picklist__c IN {soql_in(['Indonesia', 'Malaysia', 'Philippines', 'Singapore'])} "
            f"AND {VERTICAL_CLAUSE} "
            f"AND {soql_not_contains_all('Source__c', ['dimi', 'other'])}"
        ),
    },
    'EU': {
        'sheet': 'eu_ecomm_lead',
        # (1 OR 4) AND (2 OR 3) AND 5 -- no Country filter; Owner_Sub_Team__c
        # stands in for region here, and blank LeadSource ("") is included.
        'where': lambda: (
            f"(LeadSource IN {soql_in(EU_LEAD_SOURCE_VALUES)} "
            f"OR LeadSource = null "
            f"OR Attendee_Source__c = 'ABM') "
            f"AND {VERTICAL_CLAUSE} "
            f"AND Owner_Sub_Team__c LIKE '%europe%'"
        ),
    },
}

# -- IQL funnel filters, one per region. Rolling out region by region as each
# is confirmed against its report -- only India is wired up so far.
# Date field is Meeting_Booked_Date__c (not CreatedDate) -- confirmed against
# the report's "Meeting Booked Date" axis label and matches the IQL date-field
# mapping already verified earlier (100% field-population match).
IQL_LEAD_FILTERS = {
    'India': {
        'sheet': 'india_ecomm_iql',
        'dateField': 'Meeting_Booked_Date__c',
        # (1 OR 4) AND 2 AND 3 AND 5 -- only Main_Industry_Vertical__c this
        # time (no Industry OR-condition), and 5 Source exclusion terms.
        'where': lambda: (
            f"(LeadSource IN {soql_in(EU_LEAD_SOURCE_VALUES)} "
            f"OR LeadSource = null "
            f"OR Attendee_Source__c = 'ABM') "
            f"AND Country_Picklist__c = 'India' "
            f"AND ({soql_contains_terms('Main_Industry_Vertical__c', VERTICAL_MAIN_VALUES)}) "
            f"AND {soql_not_contains_all('Source__c', ['dimi', 'other', 'bank', 'bfsi', 'fintech'])}"
        ),
    },
    'SEA': {
        'sheet': 'sea_ecomm_iql',
        'dateField': 'Meeting_Booked_Date__c',
        # (1 OR 4) AND 2 AND 3 AND 5
        'where': lambda: (
            f"(LeadSource IN {soql_in(['ABM', 'Growth Marketing', 'Inbound Lead', 'Insent', 'Intercom', 'Factors Engaged'])} "
            f"OR Attendee_Source__c = 'ABM') "
            f"AND Country_Picklist__c IN {soql_in(['Indonesia', 'Malaysia', 'Philippines', 'Singapore'])} "
            f"AND ({soql_contains_terms('Main_Industry_Vertical__c', VERTICAL_MAIN_VALUES)}) "
            f"AND {soql_not_contains_all('Source__c', ['dimi', 'other', 'bank', 'bfsi', 'fintech'])}"
        ),
    },
    'EU': {
        'sheet': 'eu_ecomm_iql',
        'dateField': 'Meeting_Booked_Date__c',
        # (1 OR 3) AND 2 AND 4 -- no Country filter; Owner_Sub_Team__c stands
        # in for region, blank LeadSource included. Verified live: total 55
        # (41 Q1 FY2026 + 14 Q2 FY2026) matches the report exactly.
        'where': lambda: (
            f"(LeadSource IN {soql_in(EU_LEAD_SOURCE_VALUES)} "
            f"OR LeadSource = null "
            f"OR Attendee_Source__c = 'ABM') "
            f"AND ({soql_contains_terms('Main_Industry_Vertical__c', VERTICAL_MAIN_VALUES)}) "
            f"AND Owner_Sub_Team__c LIKE '%europe%'"
        ),
    },
}

# -- MQL funnel filters, one per region. NOTE: the "India" filter given uses
# Country_Picklist__c IN (Indonesia, Malaysia, Philippines, Singapore) -- the
# SEA country list, not India -- built exactly as given per instruction;
# flagged for the user to confirm/correct later.
# Date field is Meeting_Executed_Date__c, matching the report's axis label.
MQL_LEAD_FILTERS = {
    'India': {
        'sheet': 'india_ecomm_mql',
        'dateField': 'Meeting_Executed_Date__c',
        # (1 OR 4) AND 2 AND 3 AND 5
        'where': lambda: (
            f"(LeadSource IN {soql_in(EU_LEAD_SOURCE_VALUES)} "
            f"OR LeadSource = null "
            f"OR Attendee_Source__c = 'ABM') "
            f"AND Country_Picklist__c IN {soql_in(['Indonesia', 'Malaysia', 'Philippines', 'Singapore'])} "
            f"AND ({soql_contains_terms('Main_Industry_Vertical__c', VERTICAL_MAIN_VALUES)}) "
            f"AND {soql_not_contains_all('Source__c', ['other', 'dimi', 'bfsi'])}"
        ),
    },
    'SEA': {
        'sheet': 'sea_ecomm_mql',
        'dateField': 'Meeting_Executed_Date__c',
        # (1 OR 4) AND 2 AND 3 AND 5
        'where': lambda: (
            f"(LeadSource IN {soql_in(['ABM', 'Growth Marketing', 'Inbound Lead', 'ABM Safal Imperia', 'Insent', 'Intercom'])} "
            f"OR Attendee_Source__c = 'ABM') "
            f"AND Country_Picklist__c IN {soql_in(['Indonesia', 'Malaysia', 'Philippines', 'Singapore'])} "
            f"AND ({soql_contains_terms('Main_Industry_Vertical__c', VERTICAL_MAIN_VALUES)}) "
            f"AND {soql_not_contains_all('Source__c', ['dimi', 'other', 'bank', 'bfsi', 'fintech'])}"
        ),
    },
    'EU': {
        'sheet': 'eu_ecomm_mql',
        'dateField': 'Meeting_Executed_Date__c',
        # (1 OR 3) AND 2 AND 4 -- same filter shape as EU IQL, just on
        # Meeting Executed Date. Verified live: total 45 matches the report.
        'where': lambda: (
            f"(LeadSource IN {soql_in(EU_LEAD_SOURCE_VALUES)} "
            f"OR LeadSource = null "
            f"OR Attendee_Source__c = 'ABM') "
            f"AND ({soql_contains_terms('Main_Industry_Vertical__c', VERTICAL_MAIN_VALUES)}) "
            f"AND Owner_Sub_Team__c LIKE '%europe%'"
        ),
    },
}

# -- SQL funnel filters, one per region. Unlike Leads/IQL/MQL, this is built
# on OPPORTUNITY (report type "Opportunities with Products"), reaching through
# to OpportunityLineItem for revenue and Account for the two Factors.ai
# fields -- confirmed via schema search, since none of "Main Industry
# Vertical", "Website Category", "Factors Engagement Score", or "Factors SDR
# Tracker" exist directly on Opportunity or OpportunityLineItem.
# Date field is Opportunity.SQL_Change_Date__c.
SQL_OPPORTUNITY_FILTERS = {
    'India': {
        'sheet': 'india_ecomm_sql',
        # 1 AND 2 AND 3 AND 4 AND 5 AND (6 OR 7) AND 8
        'where': lambda: (
            f"Opportunity.Opportunity_Source__c IN {soql_in(['ABM', 'Growth Marketing', 'Inbound Lead', 'ABM Safal Imperia', 'Intercom', 'Insent', 'Factors Engaged', 'Influ 2 Engaged'])} "
            f"AND (NOT Opportunity.Owner_Team__c LIKE '%Executive%') "
            f"AND Opportunity.Owner.Name != 'CRM Administrator' "
            f"AND Opportunity.Type NOT IN {soql_in(['Refill with Approval', 'Refill without Approval', 'Renewal Without Approval', 'Renewal with Approval'])} "
            f"AND Opportunity.Owner_Sub_Team__c = 'India' "
            f"AND (Opportunity.Account.ABM_Industry_Vertical__c IN {soql_in(['E-Comm/D2C', 'Lifestyle', 'Retail', 'Conglomerate', 'FMCG'])} "
            f"OR ({soql_contains_terms('Opportunity.Account.Website_Category__c', ['e-comm', 'ecomm', 'retail', 'd2c'])})) "
            f"AND {soql_not_contains_all('Opportunity.Account.Website_Category__c', ['other', 'dimi', 'bfsi'])}"
        ),
    },
    # SEA's report filters on "SQL Change Date: Current FY" -- same dynamic
    # fiscal-year-to-date window as India's SQL report, not a fixed prior-year
    # window (corrected after the user confirmed the report's actual filter
    # text: "Current FY (01-Apr-2026 - 31-Mar-2027)").
    'SEA': {
        'sheet': 'sea_ecomm_sql',
        # 1 AND 2 AND (4 OR 3) AND 5 -- note: no Owner Team / Owner filters
        # here at all, unlike India's SQL filter; Country Name is
        # Account.Country_Picklist__c (same field API name as Lead's, but on
        # Account); Opportunity Type is an inclusion list here (incl. blank),
        # not an exclusion list like India's.
        'where': lambda: (
            f"Opportunity.Opportunity_Source__c IN {soql_in(['ABM', 'Growth Marketing', 'Inbound Lead', 'ABM Safal Imperia', 'Intercom', 'Insent', 'Digital', 'Factors Engaged', 'Influ 2 Engaged'])} "
            f"AND Opportunity.Account.Country_Picklist__c IN {soql_in(['Indonesia', 'Malaysia', 'Philippines', 'Singapore'])} "
            f"AND (Opportunity.Account.ABM_Industry_Vertical__c IN {soql_in(['E-Comm/D2C', 'Retail', 'QSR'])} "
            f"OR ({soql_contains_terms('Opportunity.Account.Website_Category__c', ['e-comm', 'ecomm', 'retail', 'd2c'])})) "
            f"AND (Opportunity.Type IN {soql_in(['New Business', 'New', 'Cross Sell', 'New (Expansion)'])} "
            f"OR Opportunity.Type = null)"
        ),
    },
    # EU's report filters on "SQL Change Date: Previous FY (01-Apr-2025 -
    # 31-Mar-2026)" -- a genuinely FIXED window, unlike India/SEA's dynamic
    # Current FY. Verified live: 0 matching opportunities in that window
    # (23 match the source/team/vertical filters outside the date window,
    # confirming the filter logic itself is sound, just currently empty).
    'EU': {
        'sheet': 'eu_ecomm_sql',
        'dateRange': ('2025-04-01', '2026-03-31'),
        # 1 AND 3 AND (4 OR 2) -- no Owner Team / Owner Name / Type filters,
        # unlike India's SQL filter.
        'where': lambda: (
            f"Opportunity.Opportunity_Source__c IN {soql_in(['ABM', 'Growth Marketing', 'Inbound Lead', 'ABM Safal Imperia', 'Intercom', 'Insent', 'Factors Engaged', 'Influ 2 Engaged'])} "
            f"AND Opportunity.Owner_Sub_Team__c LIKE '%europe%' "
            f"AND (Opportunity.Account.ABM_Industry_Vertical__c IN {soql_in(['E-Comm/D2C', 'Lifestyle', 'Retail', 'Conglomerate', 'QSR'])} "
            f"OR ({soql_contains_terms('Opportunity.Account.Website_Category__c', ['e-comm', 'ecomm', 'retail', 'd2c'])}))"
        ),
    },
}

# -- Config ---------------------------------------------------------------------
SF_LOGIN_URL      = "https://netcore.my.salesforce.com"
SHEET_ID          = os.environ['CLG_SHEET_ID']
LEADS_SHEET_NAME  = os.environ.get('CLG_LEADS_SHEET_NAME', 'Leads')
OPP_SHEET_NAME    = os.environ.get('CLG_OPPORTUNITY_SHEET_NAME', 'Opportunity')

# All credentials come from GitHub Secrets / .env.local -- never hardcoded
SF_CONSUMER_KEY    = os.environ['SF_CONSUMER_KEY']
SF_CONSUMER_SECRET = os.environ['SF_CONSUMER_SECRET']
SF_USERNAME        = os.environ.get('SF_USERNAME', '')
SF_PASSWORD        = os.environ.get('SF_PASSWORD', '')
SF_SECURITY_TOKEN  = os.environ.get('SF_SECURITY_TOKEN', '')

# Google -- individual vars (same as .env.local, no JSON file needed)
GOOGLE_CLIENT_EMAIL = os.environ['GOOGLE_CLIENT_EMAIL']
GOOGLE_PRIVATE_KEY  = os.environ['GOOGLE_PRIVATE_KEY'].replace('\\n', '\n')


# -- Salesforce auth (client credentials -> username-password fallback) --------
def get_sf_auth():
    url = f"{SF_LOGIN_URL}/services/oauth2/token"

    r = requests.post(url, data={
        "grant_type": "client_credentials",
        "client_id":  SF_CONSUMER_KEY,
        "client_secret": SF_CONSUMER_SECRET,
    }, verify=False)
    if r.status_code == 200:
        d = r.json()
        print("[SF] Authenticated via client credentials")
        return d['access_token'], d['instance_url']

    print(f"[SF] Client credentials failed ({r.status_code}), trying username-password...")
    pwd = SF_PASSWORD + SF_SECURITY_TOKEN if SF_SECURITY_TOKEN else SF_PASSWORD
    r = requests.post(url, data={
        "grant_type":  "password",
        "client_id":   SF_CONSUMER_KEY,
        "client_secret": SF_CONSUMER_SECRET,
        "username":    SF_USERNAME,
        "password":    pwd,
    }, verify=False)
    if r.status_code == 200:
        d = r.json()
        print("[SF] Authenticated via username-password")
        return d['access_token'], d['instance_url']

    raise RuntimeError(f"[SF] Auth failed: {r.text}")


# -- SOQL fetch with auto-pagination --------------------------------------------
def soql_fetch(token, instance_url, query):
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    r = requests.get(
        f"{instance_url}/services/data/v58.0/query",
        headers=headers, params={"q": query}, verify=False
    )
    r.raise_for_status()
    result   = r.json()
    records  = result.get('records', [])
    next_url = result.get('nextRecordsUrl')
    while next_url:
        r = requests.get(f"{instance_url}{next_url}", headers=headers, verify=False)
        r.raise_for_status()
        nxt = r.json()
        records.extend(nxt.get('records', []))
        next_url = nxt.get('nextRecordsUrl')
    return records


# -- Date normalizer -------------------------------------------------------------
def fmt_date(value):
    if not value:
        return ''
    try:
        dt = datetime.fromisoformat(
            value.replace('Z', '+00:00').split('+')[0].split('.')[0]
        )
        return dt.strftime('%Y-%m-%d')
    except (ValueError, AttributeError):
        return value


# -- Google Sheets: clear sheet (by tab name) and write fresh -------------------
def clear_and_write_sheet(gc, sheet_id, sheet_name, df):
    spreadsheet = gc.open_by_key(sheet_id)
    try:
        worksheet = spreadsheet.worksheet(sheet_name)
    except gspread.exceptions.WorksheetNotFound:
        worksheet = spreadsheet.add_worksheet(title=sheet_name, rows=2000, cols=26)
        print(f"  [Sheets] Created new tab '{sheet_name}'")
    worksheet.clear()
    rows = [list(df.columns)] + df.fillna('').astype(str).values.tolist()
    worksheet.update(rows, value_input_option='USER_ENTERED')
    print(f"  [Sheets] Written {len(rows) - 1} rows to '{sheet_name}'")


def get_sheets_client():
    creds = Credentials.from_service_account_info(
        {
            "type": "service_account",
            "client_email": GOOGLE_CLIENT_EMAIL,
            "private_key":  GOOGLE_PRIVATE_KEY,
            "token_uri":    "https://oauth2.googleapis.com/token",
        },
        scopes=['https://www.googleapis.com/auth/spreadsheets']
    )
    return gspread.authorize(creds)


# -- Leads sync -------------------------------------------------------------------
def sync_leads(token, instance_url, gc):
    print(f"\n[Leads] Fetching {START_DATE} -> {DATE_LABEL}...")
    query = f"""
    SELECT Id, CreatedDate, Status, Country, Marketing_Region__c,
           LeadSource, Source__c, Utm_Source__c, Utm_Campaign__c,
           Lead_Qualification_Indicator__c,
           MQL_Date__c, SQL_Date__c, Meeting_Executed_Date__c,
           Meeting_Booked_Date__c, SQL_Change_Date__c,
           Disqualified_Reason__c, Sub_Lead_Source_Category__c
    FROM Lead
    WHERE CreatedDate >= {START_DATE}
    AND   CreatedDate <= {END_DATE}
    AND   LeadSource IN {LEAD_SOURCE_IN}
    AND   Sub_Lead_Source_Category__c IN {SUB_SOURCE_IN}
    """.strip()

    records = soql_fetch(token, instance_url, query)
    print(f"  Found {len(records)} leads")
    if not records:
        return

    rows = [{
        'Id':                              r.get('Id', ''),
        'CreatedDate':                     fmt_date(r.get('CreatedDate', '')),
        'Status':                          r.get('Status', ''),
        'Country':                         r.get('Country', ''),
        'Marketing_Region__c':             r.get('Marketing_Region__c', ''),
        'LeadSource':                      r.get('LeadSource', ''),
        'Source__c':                       r.get('Source__c', ''),
        'Utm_Source__c':                   r.get('Utm_Source__c', ''),
        'Utm_Campaign__c':                 r.get('Utm_Campaign__c', ''),
        'Lead_Qualification_Indicator__c': r.get('Lead_Qualification_Indicator__c', ''),
        'MQL_Date__c':                     fmt_date(r.get('MQL_Date__c', '')),
        'SQL_Date__c':                     fmt_date(r.get('SQL_Date__c', '')),
        'Meeting_Executed_Date__c':        fmt_date(r.get('Meeting_Executed_Date__c', '')),
        'Meeting_Booked_Date__c':          fmt_date(r.get('Meeting_Booked_Date__c', '')),
        'SQL_Change_Date__c':              fmt_date(r.get('SQL_Change_Date__c', '')),
        'Disqualified_Reason__c':          r.get('Disqualified_Reason__c', ''),
        'Sub_Lead_Source_Category__c':     r.get('Sub_Lead_Source_Category__c', ''),
    } for r in records]

    clear_and_write_sheet(gc, SHEET_ID, LEADS_SHEET_NAME, pd.DataFrame(rows))


# -- Generic per-region, per-stage lead sync (Leads / IQL / MQL / SQL) -----------
# Each stage windows on its own date field (Leads: CreatedDate, IQL: Meeting_
# Booked_Date__c, etc.) -- that's why this takes dateField as a parameter
# instead of hardcoding CreatedDate everywhere.
def sync_stage_for_region(token, instance_url, gc, stage_label, region, cfg):
    date_field = cfg.get('dateField', 'CreatedDate')
    is_datetime = date_field in DATETIME_FIELDS
    range_start = FY_START_DATE if is_datetime else FY_START_DATE_ONLY
    range_end = END_DATE if is_datetime else DATE_LABEL_ONLY
    print(f"\n[{stage_label}:{region}] Fetching {range_start} -> {range_end} (by {date_field})...")
    query = f"""
    SELECT Id, CreatedDate, Status, Country, Country_Picklist__c, Marketing_Region__c,
           LeadSource, Source__c, Utm_Source__c, Utm_Campaign__c,
           Lead_Qualification_Indicator__c,
           MQL_Date__c, SQL_Date__c, Meeting_Executed_Date__c,
           Meeting_Booked_Date__c, SQL_Change_Date__c,
           Disqualified_Reason__c, Sub_Lead_Source_Category__c,
           Main_Industry_Vertical__c, Industry, NDL__c, Lead_age__c,
           Attendee_Source__c, Owner_Sub_Team__c, Owner_Team__c
    FROM Lead
    WHERE {date_field} >= {range_start}
    AND   {date_field} <= {range_end}
    AND   {cfg['where']()}
    """.strip()

    records = soql_fetch(token, instance_url, query)
    print(f"  Found {len(records)} leads")
    if not records:
        return

    rows = [{
        'Id':                              r.get('Id', ''),
        'CreatedDate':                     fmt_date(r.get('CreatedDate', '')),
        'Status':                          r.get('Status', ''),
        'Country':                         r.get('Country', ''),
        'Country_Picklist__c':             r.get('Country_Picklist__c', ''),
        'Marketing_Region__c':             r.get('Marketing_Region__c', ''),
        'LeadSource':                      r.get('LeadSource', ''),
        'Source__c':                       r.get('Source__c', ''),
        'Utm_Source__c':                   r.get('Utm_Source__c', ''),
        'Utm_Campaign__c':                 r.get('Utm_Campaign__c', ''),
        'Lead_Qualification_Indicator__c': r.get('Lead_Qualification_Indicator__c', ''),
        'MQL_Date__c':                     fmt_date(r.get('MQL_Date__c', '')),
        'SQL_Date__c':                     fmt_date(r.get('SQL_Date__c', '')),
        'Meeting_Executed_Date__c':        fmt_date(r.get('Meeting_Executed_Date__c', '')),
        'Meeting_Booked_Date__c':          fmt_date(r.get('Meeting_Booked_Date__c', '')),
        'SQL_Change_Date__c':              fmt_date(r.get('SQL_Change_Date__c', '')),
        'Disqualified_Reason__c':          r.get('Disqualified_Reason__c', ''),
        'Sub_Lead_Source_Category__c':     r.get('Sub_Lead_Source_Category__c', ''),
        'Main_Industry_Vertical__c':       r.get('Main_Industry_Vertical__c', ''),
        'Industry':                        r.get('Industry', ''),
        'NDL__c':                          r.get('NDL__c', False),
        'Lead_age__c':                     r.get('Lead_age__c', 0),
        'Attendee_Source__c':              r.get('Attendee_Source__c', ''),
        'Owner_Sub_Team__c':               r.get('Owner_Sub_Team__c', ''),
        'Owner_Team__c':                   r.get('Owner_Team__c', ''),
    } for r in records]

    clear_and_write_sheet(gc, SHEET_ID, cfg['sheet'], pd.DataFrame(rows))


# -- SQL funnel sync (OpportunityLineItem, per region) ---------------------------
# A separate function (not sync_stage_for_region) because this queries a
# different object entirely, three relationships deep (LineItem -> Opportunity
# -> Account), not just a different WHERE clause on Lead.
def sync_sql_for_region(token, instance_url, gc, region):
    cfg = SQL_OPPORTUNITY_FILTERS[region]
    date_start, date_end = cfg.get('dateRange', (FY_START_DATE_ONLY, DATE_LABEL_ONLY))
    print(f"\n[SQL:{region}] Fetching {date_start} -> {date_end} (by Opportunity.SQL_Change_Date__c)...")
    query = f"""
    SELECT Id, OpportunityId,
           Opportunity.SQL_Change_Date__c, Opportunity.CreatedDate,
           Opportunity.Opportunity_Source__c, Opportunity.Opportunity_Sub_Source__c,
           Opportunity.Name, Opportunity.Owner_Team__c, Opportunity.Owner.Name,
           Opportunity.Account.Name, Opportunity.Industry_Vertical_Account__c,
           Opportunity.Account.Account_Priority__c, Opportunity.Account.Potential_MRR__c,
           convertCurrency(Product_Amount_MRR__c) mrrConverted,
           convertCurrency(Product_Amount_ARR__c) arrConverted,
           Opportunity.Account.Factors_Engagement_Score__c,
           Opportunity.Account.Factors_SDR_Tracker__c
    FROM OpportunityLineItem
    WHERE Opportunity.SQL_Change_Date__c >= {date_start}
    AND   Opportunity.SQL_Change_Date__c <= {date_end}
    AND   {cfg['where']()}
    """.strip()

    records = soql_fetch(token, instance_url, query)
    print(f"  Found {len(records)} opportunity line items")
    if not records:
        return

    def get_nested(r, *path):
        for p in path:
            if r is None:
                return None
            r = r.get(p)
        return r

    rows = [{
        'Id':                              r.get('Id', ''),
        'OpportunityId':                   r.get('OpportunityId', ''),
        'SQL_Change_Date__c':              fmt_date(get_nested(r, 'Opportunity', 'SQL_Change_Date__c')),
        'Opportunity_CreatedDate':         fmt_date(get_nested(r, 'Opportunity', 'CreatedDate')),
        'Opportunity_Source__c':           get_nested(r, 'Opportunity', 'Opportunity_Source__c') or '',
        'Opportunity_Sub_Source__c':       get_nested(r, 'Opportunity', 'Opportunity_Sub_Source__c') or '',
        'Opportunity_Name':                get_nested(r, 'Opportunity', 'Name') or '',
        'Owner_Team__c':                   get_nested(r, 'Opportunity', 'Owner_Team__c') or '',
        'Opportunity_Owner':               get_nested(r, 'Opportunity', 'Owner', 'Name') or '',
        'Account_Name':                    get_nested(r, 'Opportunity', 'Account', 'Name') or '',
        'Industry_Vertical_Account__c':    get_nested(r, 'Opportunity', 'Industry_Vertical_Account__c') or '',
        'Account_Priority__c':             get_nested(r, 'Opportunity', 'Account', 'Account_Priority__c') or '',
        'Potential_MRR__c':                get_nested(r, 'Opportunity', 'Account', 'Potential_MRR__c') or '',
        # Converted-currency values -- these amounts are stored per-opportunity
        # in local currency (MYR/USD/etc.); the report's "(converted)" totals
        # use Salesforce's own dated exchange rate, not the raw field. Summing
        # the raw field gave 10,600 vs the report's 3,29,875 for SEA.
        'Product_Amount_MRR__c':           r.get('mrrConverted', 0) or 0,
        'Product_Amount_ARR__c':           r.get('arrConverted', 0) or 0,
        'Factors_Engagement_Score__c':     get_nested(r, 'Opportunity', 'Account', 'Factors_Engagement_Score__c') or 0,
        'Factors_SDR_Tracker__c':          get_nested(r, 'Opportunity', 'Account', 'Factors_SDR_Tracker__c') or False,
    } for r in records]

    clear_and_write_sheet(gc, SHEET_ID, cfg['sheet'], pd.DataFrame(rows))


# -- Opportunities sync -------------------------------------------------------------
def sync_opportunities(token, instance_url, gc):
    print(f"\n[Opportunities] Fetching {START_DATE} -> {DATE_LABEL}...")
    query = f"""
    SELECT Id, Name, AccountId, Amount, CloseDate, CreatedDate,
           StageName, LeadSource, utm_campaign__c,
           Projected_Opportunity_Revenue__c, CurrencyIsoCode,
           SQL_Change_Date__c, Marketing_Region__c,
           Opportunity_Source__c, Opportunity_Sub_Source__c, Source__c
    FROM Opportunity
    WHERE CreatedDate >= {START_DATE}
    AND   CreatedDate <= {END_DATE}
    AND   LeadSource IN {LEAD_SOURCE_IN}
    AND   Opportunity_Sub_Source__c IN {SUB_SOURCE_IN}
    ORDER BY CreatedDate DESC
    """.strip()

    records = soql_fetch(token, instance_url, query)
    print(f"  Found {len(records)} opportunities")
    if not records:
        return

    rows = [{
        'Id':                                r.get('Id', ''),
        'Name':                              r.get('Name', ''),
        'AccountId':                         r.get('AccountId', ''),
        'Amount':                            r.get('Amount', ''),
        'CloseDate':                         fmt_date(r.get('CloseDate', '')),
        'CreatedDate':                       fmt_date(r.get('CreatedDate', '')),
        'StageName':                         r.get('StageName', ''),
        'LeadSource':                        r.get('LeadSource', ''),
        'utm_campaign__c':                   r.get('utm_campaign__c', ''),
        'Projected_Opportunity_Revenue__c':  r.get('Projected_Opportunity_Revenue__c', ''),
        'CurrencyIsoCode':                   r.get('CurrencyIsoCode', ''),
        'SQL_Change_Date__c':                fmt_date(r.get('SQL_Change_Date__c', '')),
        'Marketing_Region__c':               r.get('Marketing_Region__c', ''),
        'Opportunity_Source__c':             r.get('Opportunity_Source__c', ''),
        'Opportunity_Sub_Source__c':         r.get('Opportunity_Sub_Source__c', ''),
        'Source__c':                         r.get('Source__c', ''),
    } for r in records]

    clear_and_write_sheet(gc, SHEET_ID, OPP_SHEET_NAME, pd.DataFrame(rows))


# -- Entry point -----------------------------------------------------------------
if __name__ == "__main__":
    print("=" * 50)
    print(f"CLG Dashboard Daily Sync -- {DATE_LABEL}")
    print("=" * 50)

    token, instance_url = get_sf_auth()
    gc = get_sheets_client()
    print("[Sheets] Auth OK")

    sync_leads(token, instance_url, gc)
    for region, cfg in REGION_LEAD_FILTERS.items():
        sync_stage_for_region(token, instance_url, gc, 'Leads', region, cfg)
    for region, cfg in IQL_LEAD_FILTERS.items():
        sync_stage_for_region(token, instance_url, gc, 'IQL', region, cfg)
    for region, cfg in MQL_LEAD_FILTERS.items():
        sync_stage_for_region(token, instance_url, gc, 'MQL', region, cfg)
    for region in SQL_OPPORTUNITY_FILTERS:
        sync_sql_for_region(token, instance_url, gc, region)
    sync_opportunities(token, instance_url, gc)

    print("\n[Done] Sync complete.")
