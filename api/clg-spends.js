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
// identified by a case-sensitive substring in Campaign Name instead.
const FACEBOOK_KEYWORD_TO_REGION = [
  ['IN_Ecomm', 'India'],
  ['SEA_Ecomm', 'SEA'],
  ['EU_Ecomm', 'EU'],
  ['LATAM_Ecomm', 'LATAM'],
];

// Email/WhatsApp (Netcore's own messaging channels, free -- no spend) have no
// region column at all. Campaign names follow a `Q<n>_<REGION>[_<REGION2>]_...`
// convention (confirmed live against both sheets), so the region is the
// LEFTMOST underscore/space/hyphen-separated token that matches a known code
// -- this correctly reads "IN_Ecomm_Global_NDL_Dimi_SEA_Email" as India (not
// SEA, which only shows up later as an audience-segment name) and
// "SEA_MEA_Ecomm_Jewel..." as SEA (its primary/first-listed region). "MEA"
// (Middle East & Africa) only shows up on these two channels, not
// LinkedIn/Facebook, so it's a Spends-tab-only region -- see
// SPENDS_MESSAGING_REGIONS in app.js.
const MESSAGING_REGION_TOKENS = { IN: 'India', SEA: 'SEA', EU: 'EU', LATAM: 'LATAM', MEA: 'MEA' };
function classifyMessagingRegion(name) {
  const tokens = name.split(/[^A-Za-z0-9]+/);
  for (const t of tokens) {
    const region = MESSAGING_REGION_TOKENS[t.toUpperCase()];
    if (region) return region;
  }
  return null;
}
// This dashboard is Ecomm-only -- Email/Whatsapp carry plenty of non-Ecomm
// campaigns (BFSI, webinars, etc.) that must be excluded.
function isEcommCampaign(name) {
  return /ecomm|e-commerce/i.test(name);
}

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

// -- Campaign -> Leads attribution --------------------------------------------
// A lead's Source__c holds the exact ad campaign name it came from (same
// naming convention as these LinkedIn/Facebook sheets' Campaign Name column --
// see pickSourceField in api/clg-regions.js, reproduced here for the one
// exception: Google Ads leads carry the campaign name in Utm_Campaign__c
// instead). Matching this against a campaign's own name (case/whitespace
// normalized) tells us how many leads that specific campaign directly
// produced, scoped to whatever date range is currently selected.
//
// Only India/SEA/EU have a synced Leads sheet so far (LATAM's is "we'll do
// that later" per the user) -- LATAM/MEA campaigns simply get 0 leads until
// that sync exists, rather than erroring.
const REGION_LEAD_SHEETS = { India: 'india_ecomm_lead', SEA: 'sea_ecomm_lead', EU: 'eu_ecomm_lead' };

function normalizeSourceName(name) {
  return (name || '').toString().trim().toLowerCase();
}

function pickSourceField(subLeadSource, sourceVal, utmCampaignVal) {
  const source = (sourceVal || '').toString().trim();
  const utmCampaign = (utmCampaignVal || '').toString().trim();
  const isGoogleAds = (subLeadSource || '').toString().trim() === 'Google Ads';
  return isGoogleAds ? (utmCampaign || source) : (source || utmCampaign);
}

// normalizedSource -> { count, records, ndlCount, ndlRecords, dlCount, dlRecords },
// scoped to [startTS, endTS] by the lead's own CreatedDate. NDL (Non Demo
// Lead) is the boolean NDL__c field; DL (Disqualified Lead) is Status ===
// 'Disqualified MQL' (same mapping the Lead Status crosstab uses -- see
// STATUS_DEFS / statusGroups in api/clg-regions.js).
const DISQUALIFIED_STATUS = 'Disqualified MQL';

function buildLeadsBySource(rows, startTS, endTS) {
  const map = new Map();
  if (rows.length < 2) return map;

  const h = rows[0];
  const cols = {
    createdDate: findCol(h, 'CreatedDate'),
    id: findCol(h, 'Id'),
    name: findCol(h, 'Name'),
    company: findCol(h, 'Company'),
    title: findCol(h, 'Title'),
    source: findCol(h, 'Source__c'),
    utmCampaign: findCol(h, 'Utm_Campaign__c'),
    subLeadSource: findCol(h, 'Sub_Lead_Source_Category__c'),
    status: findCol(h, 'Status'),
    ndl: findCol(h, 'NDL__c'),
  };

  const blank = () => ({ count: 0, records: [], ndlCount: 0, ndlRecords: [], dlCount: 0, dlRecords: [] });

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const ts = parseDate(row[cols.createdDate]);
    if (!inRange(ts, startTS, endTS)) continue;

    const sourceVal = pickSourceField(row[cols.subLeadSource], row[cols.source], row[cols.utmCampaign]);
    const norm = normalizeSourceName(sourceVal);
    if (!norm) continue;

    if (!map.has(norm)) map.set(norm, blank());
    const entry = map.get(norm);
    const record = {
      id: row[cols.id] || '',
      name: (row[cols.name] || '').toString().trim() || row[cols.id] || '(no name)',
      company: (row[cols.company] || '').toString().trim(),
      title: (row[cols.title] || '').toString().trim(),
      source: sourceVal,
    };
    entry.count += 1;
    entry.records.push(record);

    const isNdl = row[cols.ndl] === true || row[cols.ndl] === 'TRUE' || row[cols.ndl] === 'true';
    if (isNdl) {
      entry.ndlCount += 1;
      entry.ndlRecords.push(record);
    }

    const status = (row[cols.status] || '').toString().trim();
    if (status === DISQUALIFIED_STATUS) {
      entry.dlCount += 1;
      entry.dlRecords.push(record);
    }
  }
  return map;
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
    creativeName: findCol(h, 'Creative name'),
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
    const creativeName = (row[cols.creativeName] || '').toString().trim();
    const spend = parseFloat(row[cols.spend]) || 0;
    const clicks = parseFloat(row[cols.clicks]) || 0;
    const impressions = parseFloat(row[cols.impressions]) || 0;

    const regionData = byRegion[region];
    regionData.kpi.spend += spend;
    regionData.kpi.clicks += clicks;
    regionData.kpi.impressions += impressions;

    if (!regionData.campaigns.has(campaignName)) {
      regionData.campaigns.set(campaignName, { totals: emptyTotals(), creatives: new Map() });
    }
    const campaign = regionData.campaigns.get(campaignName);
    campaign.totals.spend += spend;
    campaign.totals.clicks += clicks;
    campaign.totals.impressions += impressions;

    if (!campaign.creatives.has(creativeName)) campaign.creatives.set(creativeName, emptyTotals());
    const cr = campaign.creatives.get(creativeName);
    cr.spend += spend;
    cr.clicks += clicks;
    cr.impressions += impressions;
  }
  return byRegion;
}

function toChannelResult(byRegion, leadsByRegion) {
  const result = {};
  for (const region of Object.keys(byRegion)) {
    const { campaigns, kpi } = byRegion[region];
    const leadsBySource = (leadsByRegion && leadsByRegion[region]) || new Map();
    result[region] = {
      kpi: deriveRates(kpi),
      campaigns: [...campaigns.entries()]
        .map(([name, { totals, creatives }]) => {
          const leadsEntry = leadsBySource.get(normalizeSourceName(name));
          return {
            name,
            ...deriveRates(totals),
            leadCount: leadsEntry ? leadsEntry.count : 0,
            leadRecords: leadsEntry ? leadsEntry.records : [],
            ndlCount: leadsEntry ? leadsEntry.ndlCount : 0,
            ndlRecords: leadsEntry ? leadsEntry.ndlRecords : [],
            dlCount: leadsEntry ? leadsEntry.dlCount : 0,
            dlRecords: leadsEntry ? leadsEntry.dlRecords : [],
            creatives: [...creatives.entries()]
              .map(([creativeName, creativeTotals]) => ({ name: creativeName, ...deriveRates(creativeTotals) }))
              .sort((a, b) => b.spend - a.spend),
          };
        })
        .sort((a, b) => b.spend - a.spend),
    };
  }
  return result;
}

// Email/WhatsApp: no spend at all, so the metrics are the raw send/delivery/
// engagement counts instead -- percentages are RE-DERIVED from summed counts
// for the same reason CTR/CPM are above (never average per-row percentages).
// Confirmed live against real rows: Delivered % = Delivered/Sent, while
// Unique Opened % and Unique Clicked % are both out of Delivered (not Sent).
function emptyMessagingTotals() {
  return { sent: 0, delivered: 0, totalOpened: 0, uniqueOpened: 0, totalClicked: 0, uniqueClicked: 0 };
}
function deriveMessagingRates(totals) {
  const deliveredPct = totals.sent > 0 ? (totals.delivered / totals.sent) * 100 : 0;
  const uniqueOpenedPct = totals.delivered > 0 ? (totals.uniqueOpened / totals.delivered) * 100 : 0;
  const uniqueClickedPct = totals.delivered > 0 ? (totals.uniqueClicked / totals.delivered) * 100 : 0;
  return { ...totals, deliveredPct, uniqueOpenedPct, uniqueClickedPct };
}

function buildMessagingChannelData(rows, startTS, endTS) {
  const byRegion = {
    India: { campaigns: new Map(), kpi: emptyMessagingTotals() },
    SEA: { campaigns: new Map(), kpi: emptyMessagingTotals() },
    EU: { campaigns: new Map(), kpi: emptyMessagingTotals() },
    LATAM: { campaigns: new Map(), kpi: emptyMessagingTotals() },
    MEA: { campaigns: new Map(), kpi: emptyMessagingTotals() },
  };
  if (rows.length < 2) return byRegion;

  const h = rows[0];
  const cols = {
    campaignName: findCol(h, 'Campaign Name'),
    date: findCol(h, 'Sent Date'),
    sent: findCol(h, 'Sent'),
    delivered: findCol(h, 'Delivered'),
    totalOpened: findCol(h, 'Total Opened/Read'),
    uniqueOpened: findCol(h, 'Unique Opened'),
    totalClicked: findCol(h, 'Total Clicked'),
    uniqueClicked: findCol(h, 'Unique Clicked'),
  };

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const ts = parseDate(row[cols.date]);
    if (!inRange(ts, startTS, endTS)) continue;

    const campaignName = (row[cols.campaignName] || '').toString().trim();
    if (!isEcommCampaign(campaignName)) continue;
    const region = classifyMessagingRegion(campaignName);
    if (!region) continue;

    const sent = parseFloat(row[cols.sent]) || 0;
    const delivered = parseFloat(row[cols.delivered]) || 0;
    const totalOpened = parseFloat(row[cols.totalOpened]) || 0;
    const uniqueOpened = parseFloat(row[cols.uniqueOpened]) || 0;
    const totalClicked = parseFloat(row[cols.totalClicked]) || 0;
    const uniqueClicked = parseFloat(row[cols.uniqueClicked]) || 0;

    const regionData = byRegion[region];
    regionData.kpi.sent += sent;
    regionData.kpi.delivered += delivered;
    regionData.kpi.totalOpened += totalOpened;
    regionData.kpi.uniqueOpened += uniqueOpened;
    regionData.kpi.totalClicked += totalClicked;
    regionData.kpi.uniqueClicked += uniqueClicked;

    if (!regionData.campaigns.has(campaignName)) regionData.campaigns.set(campaignName, emptyMessagingTotals());
    const c = regionData.campaigns.get(campaignName);
    c.sent += sent;
    c.delivered += delivered;
    c.totalOpened += totalOpened;
    c.uniqueOpened += uniqueOpened;
    c.totalClicked += totalClicked;
    c.uniqueClicked += uniqueClicked;
  }
  return byRegion;
}

function toMessagingChannelResult(byRegion, leadsByRegion) {
  const result = {};
  for (const region of Object.keys(byRegion)) {
    const { campaigns, kpi } = byRegion[region];
    const leadsBySource = (leadsByRegion && leadsByRegion[region]) || new Map();
    result[region] = {
      kpi: deriveMessagingRates(kpi),
      campaigns: [...campaigns.entries()]
        .map(([name, totals]) => {
          const leadsEntry = leadsBySource.get(normalizeSourceName(name));
          return {
            name,
            ...deriveMessagingRates(totals),
            leadCount: leadsEntry ? leadsEntry.count : 0,
            leadRecords: leadsEntry ? leadsEntry.records : [],
            ndlCount: leadsEntry ? leadsEntry.ndlCount : 0,
            ndlRecords: leadsEntry ? leadsEntry.ndlRecords : [],
            dlCount: leadsEntry ? leadsEntry.dlCount : 0,
            dlRecords: leadsEntry ? leadsEntry.dlRecords : [],
          };
        })
        .sort((a, b) => b.sent - a.sent),
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

    const [linkedinRows, facebookRows, emailRows, whatsappRows, ...leadRowsByRegion] = await Promise.all([
      getTab('Linkedin'), getTab('Facebook'), getTab('Email'), getTab('Whatsapp'),
      ...Object.values(REGION_LEAD_SHEETS).map(getTab),
    ]);

    const leadsByRegion = {};
    Object.keys(REGION_LEAD_SHEETS).forEach((region, i) => {
      leadsByRegion[region] = buildLeadsBySource(leadRowsByRegion[i], startTS, endTS);
    });

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

    const linkedin = toChannelResult(linkedinByRegion, leadsByRegion);
    const meta = toChannelResult(facebookByRegion, leadsByRegion);

    const emailByRegion = buildMessagingChannelData(emailRows, startTS, endTS);
    const whatsappByRegion = buildMessagingChannelData(whatsappRows, startTS, endTS);
    const email = toMessagingChannelResult(emailByRegion, leadsByRegion);
    const whatsapp = toMessagingChannelResult(whatsappByRegion, leadsByRegion);

    // LinkedIn/Meta have no MEA campaigns (paid Ecomm hasn't launched there
    // yet) and Email/Whatsapp are never queried for a region outside the 5
    // known ones -- either way, fall back to a clean zero-value shape rather
    // than leaving a hole in the response.
    const emptyPaidChannel = { kpi: deriveRates(emptyTotals()), campaigns: [] };
    const emptyMessagingChannel = { kpi: deriveMessagingRates(emptyMessagingTotals()), campaigns: [] };

    const regions = {};
    for (const region of ['India', 'SEA', 'EU', 'LATAM', 'MEA']) {
      regions[region] = {
        linkedin: linkedin[region] || emptyPaidChannel,
        meta: meta[region] || emptyPaidChannel,
        email: email[region] || emptyMessagingChannel,
        whatsapp: whatsapp[region] || emptyMessagingChannel,
      };
    }

    res.status(200).json({ startDate, endDate, regions, lastUpdated: new Date().toISOString() });
  } catch (err) {
    console.error('[clg-spends]', err);
    res.status(500).json({ error: err.message });
  }
}
