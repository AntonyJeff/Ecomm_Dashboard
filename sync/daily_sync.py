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
# "Yesterday" must be computed in IST, not raw UTC -- the GitHub Actions cron
# fires at 21:30 UTC, which IS 3:00 AM IST the next day, but is still the
# PREVIOUS calendar day in UTC. Subtracting a day from bare UTC "now" at that
# moment landed on the day before the intended one (confirmed live: a run
# that executed at 3:00 AM IST on Sep 18 computed END_DATE = Sep 16 instead of
# Sep 17, silently dropping an entire day of leads from every sync every
# single day). Converting to IST first before taking "yesterday" fixes this
# regardless of the exact minute the job actually runs.
IST = timezone(timedelta(hours=5, minutes=30))
now_ist    = datetime.now(timezone.utc).astimezone(IST)
yesterday  = now_ist - timedelta(days=1)
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
# Standardized Leads filter (given directly by the user, superseding the
# old per-report-screenshot mirroring for this stage): one shared template --
# LeadSource IN (...) OR Attendee_Source__c = 'ABM' -- AND [region] AND
# (Main_Industry_Vertical__c contains... OR Industry contains...) -- with a
# Source__c-not-contains-'dimi' exclusion for India/SEA only. Region is the
# ONLY thing that varies between India/SEA; EU drops the Country filter (no
# single country works for "Europe") and the Source exclusion entirely, and
# swaps in Owner_Sub_Team__c LIKE '%europe%' instead -- both changes given
# explicitly by the user, verified live (India 189, SEA 11, EU 32 for
# Apr 1 - Sep 9 2026).
STANDARD_LEAD_SOURCE_VALUES = [
    'ABM', 'Growth Marketing', 'Inbound Lead', 'ABM Safal Imperia',
    'Insent/ChatBot', 'Intercom', 'Factors Engaged', 'Influ 2 Engaged',
]
STANDARD_LEAD_SOURCE_CLAUSE = (
    f"(LeadSource IN {soql_in(STANDARD_LEAD_SOURCE_VALUES)} "
    f"OR Attendee_Source__c = 'ABM')"
)

# LATAM/MEA Leads/IQL/MQL filters (given directly by the user) are genuinely
# simpler than India/SEA/EU's -- just LeadSource + Region, no vertical filter,
# no Source__c exclusion, no Attendee_Source__c OR-clause. Region__c (label
# "Region" in the report UI) is a DIFFERENT field from Marketing_Region__c --
# confirmed via live Lead schema describe: Region__c is a picklist with
# exactly ['EU', 'India', 'LATAM', 'MEA', 'North America', 'Others', 'SEA'],
# matching the report's filter values, where Marketing_Region__c is a plain
# string field used elsewhere (Account TAL matching) instead.
LATAM_MEA_LEAD_SOURCE_VALUES = [
    'ABM', 'Growth Marketing', 'Inbound Lead', 'ABM Safal Imperia',
    'Insent/ChatBot', 'Intercom', 'Digital', 'Factors Engaged', 'Influ 2 Engaged',
]

REGION_LEAD_FILTERS = {
    'India': {
        'sheet': 'india_ecomm_lead',
        # (1 OR 5) AND 2 AND (3 OR 4) AND 6
        'where': lambda: (
            f"{STANDARD_LEAD_SOURCE_CLAUSE} "
            f"AND Country_Picklist__c = 'India' "
            f"AND {VERTICAL_CLAUSE} "
            f"AND {soql_not_contains_all('Source__c', ['dimi'])}"
        ),
    },
    'SEA': {
        'sheet': 'sea_ecomm_lead',
        # (1 OR 5) AND 2 AND (3 OR 4) AND 6 -- identical to India except Country
        'where': lambda: (
            f"{STANDARD_LEAD_SOURCE_CLAUSE} "
            f"AND Country_Picklist__c IN {soql_in(['Indonesia', 'Malaysia', 'Philippines', 'Singapore'])} "
            f"AND {VERTICAL_CLAUSE} "
            f"AND {soql_not_contains_all('Source__c', ['dimi'])}"
        ),
    },
    'EU': {
        'sheet': 'eu_ecomm_lead',
        # (1 OR 4) AND (2 OR 3) AND 5 -- no Country filter and no Source
        # exclusion; Owner_Sub_Team__c stands in for region.
        'where': lambda: (
            f"{STANDARD_LEAD_SOURCE_CLAUSE} "
            f"AND {VERTICAL_CLAUSE} "
            f"AND Owner_Sub_Team__c LIKE '%europe%'"
        ),
    },
    'LATAM': {
        'sheet': 'latam_ecomm_lead',
        'where': lambda: (
            f"LeadSource IN {soql_in(LATAM_MEA_LEAD_SOURCE_VALUES)} "
            f"AND Region__c = 'LATAM'"
        ),
    },
    'MEA': {
        'sheet': 'mea_ecomm_lead',
        'where': lambda: (
            f"LeadSource IN {soql_in(LATAM_MEA_LEAD_SOURCE_VALUES)} "
            f"AND Region__c = 'MEA'"
        ),
    },
}

# -- IQL funnel filters, one per region -- standardized template (given
# directly by the user), same shared-clause pattern as REGION_LEAD_FILTERS.
# Note this stage's LeadSource list has NO 'ABM Safal Imperia' (unlike the
# Leads stage's list) and vertical is Main_Industry_Vertical__c ONLY (no
# Industry OR-condition). Date field is Meeting_Booked_Date__c, matching the
# report's "Meeting Booked Date" axis label.
IQL_LEAD_SOURCE_VALUES = [
    'ABM', 'Growth Marketing', 'Inbound Lead', 'Insent/ChatBot',
    'Intercom', 'Factors Engaged', 'Influ 2 Engaged',
]
IQL_LEAD_SOURCE_CLAUSE = (
    f"(LeadSource IN {soql_in(IQL_LEAD_SOURCE_VALUES)} "
    f"OR Attendee_Source__c = 'ABM')"
)
IQL_VERTICAL_CLAUSE = f"({soql_contains_terms('Main_Industry_Vertical__c', VERTICAL_MAIN_VALUES)})"

IQL_LEAD_FILTERS = {
    'India': {
        'sheet': 'india_ecomm_iql',
        'dateField': 'Meeting_Booked_Date__c',
        # (1 OR 4) AND 2 AND 3 AND 5 -- verified live: total 56 (Apr 1 - Sep 9 2026).
        'where': lambda: (
            f"{IQL_LEAD_SOURCE_CLAUSE} "
            f"AND Country_Picklist__c = 'India' "
            f"AND {IQL_VERTICAL_CLAUSE} "
            f"AND {soql_not_contains_all('Source__c', ['dimi', 'other', 'bank', 'bfsi', 'fintech'])}"
        ),
    },
    'SEA': {
        'sheet': 'sea_ecomm_iql',
        'dateField': 'Meeting_Booked_Date__c',
        # (1 OR 4) AND 2 AND 3 AND 5 -- identical to India except Country.
        # Verified live: total 3 (Apr 1 - Sep 9 2026).
        'where': lambda: (
            f"{IQL_LEAD_SOURCE_CLAUSE} "
            f"AND Country_Picklist__c IN {soql_in(['Indonesia', 'Malaysia', 'Philippines', 'Singapore'])} "
            f"AND {IQL_VERTICAL_CLAUSE} "
            f"AND {soql_not_contains_all('Source__c', ['dimi', 'other', 'bank', 'bfsi', 'fintech'])}"
        ),
    },
    'EU': {
        'sheet': 'eu_ecomm_iql',
        'dateField': 'Meeting_Booked_Date__c',
        # (1 OR 3) AND 2 AND 4 -- no Country filter and no Source exclusion;
        # Owner_Sub_Team__c stands in for region. Verified live: total 8
        # (Apr 1 - Sep 9 2026).
        'where': lambda: (
            f"{IQL_LEAD_SOURCE_CLAUSE} "
            f"AND {IQL_VERTICAL_CLAUSE} "
            f"AND Owner_Sub_Team__c LIKE '%europe%'"
        ),
    },
    'LATAM': {
        'sheet': 'latam_ecomm_iql',
        'dateField': 'Meeting_Booked_Date__c',
        'where': lambda: (
            f"LeadSource IN {soql_in(LATAM_MEA_LEAD_SOURCE_VALUES)} "
            f"AND Region__c = 'LATAM'"
        ),
    },
    'MEA': {
        'sheet': 'mea_ecomm_iql',
        'dateField': 'Meeting_Booked_Date__c',
        'where': lambda: (
            f"LeadSource IN {soql_in(LATAM_MEA_LEAD_SOURCE_VALUES)} "
            f"AND Region__c = 'MEA'"
        ),
    },
}

# -- MQL funnel filters, one per region -- standardized template (given
# directly by the user). This stage's LeadSource list DOES include 'ABM
# Safal Imperia' (like Leads, unlike IQL), and its Source exclusion is only
# 3 terms (other/dimi/bfsi, no bank/fintech). Date field is
# Meeting_Executed_Date__c, matching the report's axis label.
MQL_LEAD_SOURCE_VALUES = [
    'ABM', 'Growth Marketing', 'Inbound Lead', 'ABM Safal Imperia',
    'Insent/ChatBot', 'Intercom', 'Factors Engaged', 'Influ 2 Engaged',
]
MQL_LEAD_SOURCE_CLAUSE = (
    f"(LeadSource IN {soql_in(MQL_LEAD_SOURCE_VALUES)} "
    f"OR Attendee_Source__c = 'ABM')"
)
MQL_VERTICAL_CLAUSE = f"({soql_contains_terms('Main_Industry_Vertical__c', VERTICAL_MAIN_VALUES)})"

MQL_LEAD_FILTERS = {
    'India': {
        'sheet': 'india_ecomm_mql',
        'dateField': 'Meeting_Executed_Date__c',
        # (1 OR 4) AND 2 AND 3 AND 5 -- verified live: total 44 (Apr 1 - Sep 9 2026).
        'where': lambda: (
            f"{MQL_LEAD_SOURCE_CLAUSE} "
            f"AND Country_Picklist__c = 'India' "
            f"AND {MQL_VERTICAL_CLAUSE} "
            f"AND {soql_not_contains_all('Source__c', ['other', 'dimi', 'bfsi'])}"
        ),
    },
    'SEA': {
        'sheet': 'sea_ecomm_mql',
        'dateField': 'Meeting_Executed_Date__c',
        # (1 OR 4) AND 2 AND 3 AND 5 -- identical to India except Country.
        # Verified live: total 3 (Apr 1 - Sep 9 2026).
        'where': lambda: (
            f"{MQL_LEAD_SOURCE_CLAUSE} "
            f"AND Country_Picklist__c IN {soql_in(['Indonesia', 'Malaysia', 'Philippines', 'Singapore'])} "
            f"AND {MQL_VERTICAL_CLAUSE} "
            f"AND {soql_not_contains_all('Source__c', ['other', 'dimi', 'bfsi'])}"
        ),
    },
    'EU': {
        'sheet': 'eu_ecomm_mql',
        'dateField': 'Meeting_Executed_Date__c',
        # (1 OR 3) AND 2 AND 4 -- no Country filter and no Source exclusion;
        # Owner_Sub_Team__c stands in for region. Verified live: total 5
        # (Apr 1 - Sep 9 2026).
        'where': lambda: (
            f"{MQL_LEAD_SOURCE_CLAUSE} "
            f"AND {MQL_VERTICAL_CLAUSE} "
            f"AND Owner_Sub_Team__c LIKE '%europe%'"
        ),
    },
    # LATAM/MEA MQL adds one more filter beyond Leads/IQL's shape: "MQL equals
    # Yes" -- confirmed live via Lead schema describe that this is MQL__c, a
    # PICKLIST (not a checkbox) with values ['Yes', 'No'].
    'LATAM': {
        'sheet': 'latam_ecomm_mql',
        'dateField': 'Meeting_Executed_Date__c',
        'where': lambda: (
            f"LeadSource IN {soql_in(LATAM_MEA_LEAD_SOURCE_VALUES)} "
            f"AND Region__c = 'LATAM' "
            f"AND MQL__c = 'Yes'"
        ),
    },
    'MEA': {
        'sheet': 'mea_ecomm_mql',
        'dateField': 'Meeting_Executed_Date__c',
        'where': lambda: (
            f"LeadSource IN {soql_in(LATAM_MEA_LEAD_SOURCE_VALUES)} "
            f"AND Region__c = 'MEA' "
            f"AND MQL__c = 'Yes'"
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
        # 1 AND 2 AND 3 AND 4 AND 5 AND (6 OR 7) AND 8 -- "Current FY
        # (01-Apr-2026 - 31-Mar-2027)"; no fixed dateRange needed since the
        # default dynamic FY-to-date window (Apr 1 - yesterday) already
        # produces an identical count (25) -- no data exists past today anyway.
        'where': lambda: (
            f"Opportunity.Opportunity_Source__c IN {soql_in(['ABM', 'Growth Marketing', 'Inbound Lead', 'ABM Safal Imperia', 'Intercom', 'Insent/ChatBot', 'Factors Engaged', 'Influ 2 Engaged'])} "
            f"AND (NOT Opportunity.Owner_Team__c LIKE '%Executive%') "
            f"AND Opportunity.Owner.Name != 'CRM Administrator' "
            f"AND Opportunity.Type NOT IN {soql_in(['Refill with Approval', 'Refill without Approval', 'Renewal Without Approval', 'Renewal with Approval'])} "
            f"AND Opportunity.Owner_Sub_Team__c = 'India' "
            f"AND (Opportunity.Account.ABM_Industry_Vertical__c IN {soql_in(['E-Comm/D2C', 'Lifestyle', 'Retail', 'Conglomerate', 'FMCG'])} "
            f"OR ({soql_contains_terms('Opportunity.Account.Website_Category__c', ['e-comm', 'ecomm', 'retail', 'd2c'])})) "
            f"AND {soql_not_contains_all('Opportunity.Account.Website_Category__c', ['other', 'dimi', 'bfsi'])}"
        ),
    },
    # SEA's report filters on "SQL Change Date: Previous FY (01-Apr-2025 -
    # 31-Mar-2026)" -- a genuinely FIXED prior-year window, same shape as EU's.
    'SEA': {
        'sheet': 'sea_ecomm_sql',
        'dateRange': ('2025-04-01', '2026-03-31'),
        # 1 AND 2 AND (4 OR 3) AND 5 -- note: no Owner Team / Owner filters
        # here at all, unlike India's SQL filter; Country Name is
        # Account.Country_Picklist__c (same field API name as Lead's, but on
        # Account); Opportunity Type is an inclusion list here (incl. blank),
        # not an exclusion list like India's.
        'where': lambda: (
            f"Opportunity.Opportunity_Source__c IN {soql_in(['ABM', 'Growth Marketing', 'Inbound Lead', 'ABM Safal Imperia', 'Intercom', 'Insent/ChatBot', 'Digital', 'Factors Engaged', 'Influ 2 Engaged'])} "
            f"AND Opportunity.Account.Country_Picklist__c IN {soql_in(['Indonesia', 'Malaysia', 'Philippines', 'Singapore'])} "
            f"AND (Opportunity.Account.ABM_Industry_Vertical__c IN {soql_in(['E-Comm/D2C', 'Retail', 'QSR'])} "
            f"OR ({soql_contains_terms('Opportunity.Account.Website_Category__c', ['e-comm', 'ecomm', 'retail', 'd2c'])})) "
            f"AND (Opportunity.Type IN {soql_in(['New Business', 'New', 'Cross Sell', 'New (Expansion)'])} "
            f"OR Opportunity.Type = null)"
        ),
    },
    # EU's report filters on "SQL Change Date: Previous FY (01-Apr-2025 -
    # 31-Mar-2026)" -- a genuinely FIXED window, unlike India's dynamic
    # Current FY. Verified live: 0 matching opportunities in that window.
    'EU': {
        'sheet': 'eu_ecomm_sql',
        'dateRange': ('2025-04-01', '2026-03-31'),
        # 1 AND 3 AND (4 OR 2) -- no Owner Team / Owner Name / Type filters,
        # unlike India's SQL filter.
        'where': lambda: (
            f"Opportunity.Opportunity_Source__c IN {soql_in(['ABM', 'Growth Marketing', 'Inbound Lead', 'ABM Safal Imperia', 'Intercom', 'Insent/ChatBot', 'Factors Engaged', 'Influ 2 Engaged'])} "
            f"AND Opportunity.Owner_Sub_Team__c LIKE '%europe%' "
            f"AND (Opportunity.Account.ABM_Industry_Vertical__c IN {soql_in(['E-Comm/D2C', 'Lifestyle', 'Retail', 'Conglomerate', 'QSR'])} "
            f"OR ({soql_contains_terms('Opportunity.Account.Website_Category__c', ['e-comm', 'ecomm', 'retail', 'd2c'])}))"
        ),
    },
    # LATAM/MEA SQL filters (given directly by the user) use a dynamic
    # "Current FY" window like India (no fixedDateRange, unlike SEA/EU's fixed
    # prior-FY), a different Opportunity Type list (Up Sell instead of Cross
    # Sell alongside it), and filter on Opportunity.Marketing_Region__c
    # directly (a field that already exists and is already used for Account
    # matching -- confirmed live: real Opportunity rows carry the exact
    # values 'LATAM' and 'MEA' in this field) rather than Owner_Sub_Team__c or
    # a vertical/website-category clause.
    'LATAM': {
        'sheet': 'latam_ecomm_sql',
        'where': lambda: (
            f"Opportunity.Opportunity_Source__c IN {soql_in(['ABM', 'Growth Marketing', 'Inbound Lead', 'ABM Safal Imperia', 'Intercom', 'Insent/ChatBot', 'Digital Agency', 'Digital', 'Factors Engaged', 'Influ 2 Engaged'])} "
            f"AND Opportunity.Type IN {soql_in(['New Business', 'New', 'Up Sell', 'Cross Sell', 'New (Expansion)'])} "
            f"AND Opportunity.Marketing_Region__c = 'LATAM'"
        ),
    },
    'MEA': {
        'sheet': 'mea_ecomm_sql',
        'where': lambda: (
            f"Opportunity.Opportunity_Source__c IN {soql_in(['ABM', 'Growth Marketing', 'Inbound Lead', 'ABM Safal Imperia', 'Intercom', 'Insent/ChatBot', 'Digital Agency', 'Digital', 'Factors Engaged', 'Influ 2 Engaged'])} "
            f"AND Opportunity.Type IN {soql_in(['New Business', 'New', 'Up Sell', 'Cross Sell', 'New (Expansion)'])} "
            f"AND Opportunity.Marketing_Region__c = 'MEA'"
        ),
    },
}

# -- Config ---------------------------------------------------------------------
SF_LOGIN_URL      = "https://netcore.my.salesforce.com"
SHEET_ID          = os.environ['CLG_SHEET_ID']
LEADS_SHEET_NAME  = os.environ.get('CLG_LEADS_SHEET_NAME', 'Leads')
OPP_SHEET_NAME    = os.environ.get('CLG_OPPORTUNITY_SHEET_NAME', 'Opportunity')
ACCOUNTS_SHEET_NAME = os.environ.get('CLG_ACCOUNTS_SHEET_NAME', 'Global Ecomm TAL')

# -- Accounts filter (TAL/Non-TAL classification input) -- mirrors the report
# filter given directly by the user: Show Me = All accounts, Created Date =
# All Time (deliberately unbounded -- a pre-existing TAL account may predate
# our Ecomm motion entirely, so filtering by START_DATE here would wrongly
# hide it and misclassify its leads as Non-TAL), Marketing Region equals
# India/MEA/SEA/EU/LATAM, Website Category contains Ecomm/retail/d2c/e-comm/
# other/dimi -- widened from the original Ecomm/retail/d2c/e-comm-only filter
# per the user's updated filter definition (added after Ruptub Solutions Pvt.
# Ltd (Treebo Hotels), Website_Category__c = 'DOM_DIMI', was found missing
# from this sheet entirely under the old filter).
# Verified live against Salesforce: both fields exist on Account exactly as
# named (Marketing_Region__c picklist, Website_Category__c string).
ACCOUNT_REGION_VALUES = ['India', 'MEA', 'SEA', 'EU', 'LATAM']
ACCOUNT_WEBSITE_CATEGORY_VALUES = ['Ecomm', 'retail', 'd2c', 'e-comm', 'other', 'dimi']
ACCOUNT_WHERE = (
    f"Marketing_Region__c IN {soql_in(ACCOUNT_REGION_VALUES)} "
    f"AND ({soql_contains_terms('Website_Category__c', ACCOUNT_WEBSITE_CATEGORY_VALUES)})"
)

# All credentials come from GitHub Secrets / .env.local -- never hardcoded
SF_CONSUMER_KEY    = os.environ['SF_CONSUMER_KEY']
SF_CONSUMER_SECRET = os.environ['SF_CONSUMER_SECRET']
SF_USERNAME        = os.environ.get('SF_USERNAME', '')
SF_PASSWORD        = os.environ.get('SF_PASSWORD', '')
SF_SECURITY_TOKEN  = os.environ.get('SF_SECURITY_TOKEN', '')

# Google -- individual vars (same as .env.local, no JSON file needed)
GOOGLE_CLIENT_EMAIL = os.environ['GOOGLE_CLIENT_EMAIL'].strip()
# Accept either the .env.local style (one line, literal \n escapes) or a
# secret pasted as the real multi-line PEM (actual newlines) -- the latter is
# what you get pasting straight from Google Cloud's downloaded key, and is
# much less likely to get mangled going through a GitHub secret text box than
# a 1700-character single line depending on every \n surviving copy-paste.
GOOGLE_PRIVATE_KEY = os.environ['GOOGLE_PRIVATE_KEY'].strip()
if '\n' not in GOOGLE_PRIVATE_KEY:
    GOOGLE_PRIVATE_KEY = GOOGLE_PRIVATE_KEY.replace('\\n', '\n')


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
    SELECT Id, Name, Company, Title, CreatedDate, Status, Country, Country_Picklist__c, Marketing_Region__c,
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
        'Name':                            r.get('Name', ''),
        'Company':                         r.get('Company', ''),
        'Title':                           r.get('Title', ''),
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

    # The Leads tab's "MRR" column (added per user request) attributes each
    # SQL opportunity's MRR back to the Sub Lead Source / Create Date quarter
    # of the LEAD it converted from -- Opportunity has no such field itself,
    # so this traces back via the standard Lead.ConvertedOpportunityId link.
    # Verified live: 10/10 of India's current SQL opportunities trace back to
    # a lead successfully, though only ~40% of those leads have a populated
    # Sub_Lead_Source_Category__c -- the rest fall into the same "Inbound
    # Leads" blank-value bucket the Leads tab already uses elsewhere.
    opp_ids = sorted({r.get('OpportunityId') for r in records if r.get('OpportunityId')})
    lead_by_opp_id = {}
    for i in range(0, len(opp_ids), 200):
        batch = opp_ids[i:i + 200]
        lead_query = (
            f"SELECT ConvertedOpportunityId, Sub_Lead_Source_Category__c, CreatedDate, LeadSource "
            f"FROM Lead WHERE ConvertedOpportunityId IN {soql_in(batch)}"
        )
        for lead in soql_fetch(token, instance_url, lead_query):
            lead_by_opp_id[lead['ConvertedOpportunityId']] = lead

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
        'Lead_Sub_Lead_Source_Category__c': (lead_by_opp_id.get(r.get('OpportunityId'), {}) or {}).get('Sub_Lead_Source_Category__c') or '',
        'Lead_CreatedDate':                fmt_date((lead_by_opp_id.get(r.get('OpportunityId'), {}) or {}).get('CreatedDate')),
        'Lead_LeadSource':                 (lead_by_opp_id.get(r.get('OpportunityId'), {}) or {}).get('LeadSource') or '',
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


# -- Accounts sync (TAL/Non-TAL classification input) ----------------------------
# Unlike every other sync here, this pulls the full unfiltered-by-date Account
# universe matching the region/vertical filter -- see ACCOUNT_WHERE above for
# why CreatedDate must stay unbounded.
def sync_accounts(token, instance_url, gc):
    print(f"\n[Accounts] Fetching all-time matching accounts...")
    query = f"""
    SELECT Id, Name, CreatedDate, Marketing_Region__c, Website_Category__c
    FROM Account
    WHERE {ACCOUNT_WHERE}
    """.strip()

    records = soql_fetch(token, instance_url, query)
    print(f"  Found {len(records)} accounts")
    if not records:
        return

    rows = [{
        'Id':                     r.get('Id', ''),
        'Name':                   r.get('Name', ''),
        'CreatedDate':            fmt_date(r.get('CreatedDate', '')),
        'Marketing_Region__c':    r.get('Marketing_Region__c', ''),
        'Website_Category__c':    r.get('Website_Category__c', ''),
    } for r in records]

    clear_and_write_sheet(gc, SHEET_ID, ACCOUNTS_SHEET_NAME, pd.DataFrame(rows))


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
    sync_accounts(token, instance_url, gc)

    print("\n[Done] Sync complete.")
