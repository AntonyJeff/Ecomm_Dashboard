// Campaign spend performance (LinkedIn + Meta) for the Spends tab.
// The 'Linkedin' and 'Facebook' sheets are populated by an external process
// (Two Minutes Report), NOT by our own sync script -- this endpoint only
// reads them. Each sheet is a day-by-day breakdown per campaign; ecom
// campaigns are identified by an exact Campaign Group Name match (LinkedIn)
// or a Campaign Name substring match (Facebook), then rows in the selected
// date range are grouped by Campaign Name, summing the raw metrics and
// RE-DERIVING CTR/CPM/CPC from those sums -- averaging the per-day
// percentages/rates directly would be mathematically wrong once days of very
// different volume are combined.
import { google } from 'googleapis';

// LinkedIn: match is on the exact, case-sensitive Campaign Group Name (given
// directly by the user, copy-pasted from Slack -- confirmed live against the
// sheet, all four exist verbatim).
const LINKEDIN_GROUP_TO_REGION = {
  'India ABM Ecomm Campaigns': 'India',
  'EU ABM Ecomm Campaigns': 'EU',
  'SEA ABM Ecomm campaigns': 'SEA',
  'LATAM_ABM_Ecommerce_Campaigns': 'LATAM',
};

// Facebook has no Campaign Group Name column -- ecom campaigns are
// identified by a case-sensitive substring in Campaign Name instead. No
// LATAM keyword was given, so Facebook/LATAM is always empty (confirmed:
// this isn't a bug, just no such campaigns exist yet).
const FACEBOOK_KEYWORD_TO_REGION = [
  ['IN_Ecomm', 'India'],
  ['SEA_Ecomm', 'SEA'],
  ['EU_Ecomm', 'EU'],
];

const findCol = (headers, name) => headers.findIndex(h => (h || '').toString().trim().toLowerCase() === name.toLowerCase());

function dayTS(dateStr) {
  const d = new Date(dateStr);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
// Google Sheets serial dates (day count since 1899-12-30) show up when a
// column is date-formatted -- confirmed live, the Date column comes back as
// a bare number (e.g. 46171) under UNFORMATTED_VALUE, not a string.
function parseDate(val) {
  if (!val && val !== 0) return null;
  let d;
  if (typeof val === 'number') {
    d = new Date((val - 25569) * 86400000);
  } else {
    d = new Date(val);
  }
  if (isNaN(d.getTime())) return null;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
function inRange(ts, startTS, endTS) {
  return ts !== null && ts >= startTS && ts <= endTS;
}

function emptyTotals() {
  return { spend: 0, clicks: 0, impressions: 0 };
}
function deriveRates(totals) {
  const ctr = totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0;
  const cpm = totals.impressions > 0 ? (totals.spend / totals.impressions) * 1000 : 0;
  const cpc = totals.clicks > 0 ? totals.spend / totals.clicks : 0;
  return { ...totals, ctr, cpm, cpc };
}

// Builds { India: {campaigns: Map<name, totals>, kpi: totals}, SEA: {...}, ... }
// for one channel's raw sheet rows, already scoped to [startTS, endTS].
function buildChannelData(rows, startTS, endTS, classifyRow) {
  const byRegion = {
    India: { campaigns: new Map(), kpi: emptyTotals() },
    SEA: { campaigns: new Map(), kpi: emptyTotals() },
    EU: { campaigns: new Map(), kpi: emptyTotals() },
    LATAM: { campaigns: new Map(), kpi: emptyTotals() },
  };
  if (rows.length < 2) return byRegion;

  const h = rows[0];
  const cols = {
    campaignName: findCol(h, 'Campaign name'),
    date: findCol(h, 'Date'),
    spend: findCol(h, 'Amount spent'),
    clicks: findCol(h, 'Clicks'),
    impressions: findCol(h, 'Impressions'),
  };

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const ts = parseDate(row[cols.date]);
    if (!inRange(ts, startTS, endTS)) continue;

    const region = classifyRow(row, h);
    if (!region) continue;

    const campaignName = (row[cols.campaignName] || '').toString().trim();
    const spend = parseFloat(row[cols.spend]) || 0;
    const clicks = parseFloat(row[cols.clicks]) || 0;
    const impressions = parseFloat(row[cols.impressions]) || 0;

    const regionData = byRegion[region];
    regionData.kpi.spend += spend;
    regionData.kpi.clicks += clicks;
    regionData.kpi.impressions += impressions;

    if (!regionData.campaigns.has(campaignName)) regionData.campaigns.set(campaignName, emptyTotals());
    const c = regionData.campaigns.get(campaignName);
    c.spend += spend;
    c.clicks += clicks;
    c.impressions += impressions;
  }
  return byRegion;
}

function toChannelResult(byRegion) {
  const result = {};
  for (const region of Object.keys(byRegion)) {
    const { campaigns, kpi } = byRegion[region];
    result[region] = {
      kpi: deriveRates(kpi),
      campaigns: [...campaigns.entries()]
        .map(([name, totals]) => ({ name, ...deriveRates(totals) }))
        .sort((a, b) => b.spend - a.spend),
    };
  }
  return result;
}

export default async function handler(req, res) {
  try {
    const startDate = (req.query && req.query.startDate) || '2026-04-01';
    const endDate = (req.query && req.query.endDate) || new Date().toISOString().slice(0, 10);
    const startTS = dayTS(startDate);
    const endTS = dayTS(endDate);

    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    const client = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: client });
    const sheetId = process.env.CLG_SHEET_ID;

    const getTab = async (tab) => {
      try {
        const r = await sheets.spreadsheets.values.get({
          spreadsheetId: sheetId,
          range: tab,
          valueRenderOption: 'UNFORMATTED_VALUE',
        });
        return r.data.values || [];
      } catch (err) {
        return [];
      }
    };

    const [linkedinRows, facebookRows] = await Promise.all([getTab('Linkedin'), getTab('Facebook')]);

    const linkedinByRegion = buildChannelData(linkedinRows, startTS, endTS, (row, h) => {
      const groupCol = findCol(h, 'Campaign group name');
      const group = (row[groupCol] || '').toString().trim();
      return LINKEDIN_GROUP_TO_REGION[group] || null;
    });

    const facebookByRegion = buildChannelData(facebookRows, startTS, endTS, (row, h) => {
      const nameCol = findCol(h, 'Campaign name');
      const name = (row[nameCol] || '').toString();
      for (const [keyword, region] of FACEBOOK_KEYWORD_TO_REGION) {
        if (name.includes(keyword)) return region;
      }
      return null;
    });

    const linkedin = toChannelResult(linkedinByRegion);
    const meta = toChannelResult(facebookByRegion);

    const regions = {};
    for (const region of ['India', 'SEA', 'EU', 'LATAM']) {
      regions[region] = { linkedin: linkedin[region], meta: meta[region] };
    }

    res.status(200).json({ startDate, endDate, regions, lastUpdated: new Date().toISOString() });
  } catch (err) {
    console.error('[clg-spends]', err);
    res.status(500).json({ error: err.message });
  }
}
