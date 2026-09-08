import { google } from 'googleapis';

// One sheet per (region, stage). Rolling out stage by stage -- only the sheets
// that actually exist get real data; the rest resolve to an empty/zeroed
// response until their sync is wired up (see daily_sync.py REGION_LEAD_FILTERS
// / IQL_LEAD_FILTERS etc).
const REGION_SHEETS = {
  India: { lead: 'india_ecomm_lead', iql: 'india_ecomm_iql', mql: 'india_ecomm_mql', sql: 'india_ecomm_sql' },
  SEA: { lead: 'sea_ecomm_lead', iql: 'sea_ecomm_iql', mql: 'sea_ecomm_mql', sql: 'sea_ecomm_sql' },
  EU: { lead: 'eu_ecomm_lead', iql: 'eu_ecomm_iql', mql: 'eu_ecomm_mql', sql: 'eu_ecomm_sql' },
};

// Leads pivots/charts by Sub Lead Source with a colored breakdown (matches the
// "Digital India Ecomm Funnel View" report). IQL/MQL/SQL pivot by Lead Source
// instead, and their top chart is a single plain bar per quarter with no
// sub-category color breakdown (matches the "...IQL Funnel View" report).
const METRICS_FULL = [
  { key: 'leadAge', label: 'Sum of Lead age', bold: false },
  { key: 'ndl', label: 'Sum of NDL', bold: false },
  { key: 'count', label: 'Record Count', bold: true },
];
// MQL's report table has no Lead Age column at all, and its own metric labels
// ("Sum NDL" / "Count") -- reproduced exactly rather than reusing Leads/IQL's.
const METRICS_MQL = [
  { key: 'ndl', label: 'Sum NDL', bold: false },
  { key: 'count', label: 'Count', bold: true },
];
// The Leads tab's own Lead Status crosstab (added per user request, on top of
// the original report) drops Lead Age entirely -- only this stage's KPI tiles
// and table use this metric set; IQL/MQL keep Lead Age untouched.
const METRICS_LEAD_STATUS = [
  { key: 'ndl', label: 'Sum of NDL', bold: false },
  { key: 'count', label: 'Record Count', bold: true },
];

// Defaults, keyed by stage. Each region's ACTUAL report can (and does) differ
// from these -- e.g. SEA's IQL groups by Owner Team where India's groups by
// Lead Source, and SEA's MQL keeps Quarter as the outer/merged column where
// India's reverses it. REGION_STAGE_OVERRIDES below patches those per region;
// getStageConfig() merges default + override so most regions need zero
// overrides and only the real differences are called out.
const STAGE_DEFAULTS = {
  lead: {
    label: 'Leads', rowField: 'Sub_Lead_Source_Category__c', rowFieldLabel: 'Sub Lead Source',
    chartMode: 'breakdown', dateField: 'CreatedDate', dateFieldLabel: 'Create Date',
    outerField: 'quarter', metrics: METRICS_LEAD_STATUS,
    // Tags the funnel-equivalent Lead Status columns with their stage name --
    // user asked for this specifically on the Leads tab (which now doubles as
    // an at-a-glance funnel view) so "Meeting booked" etc. read unambiguously
    // as the IQL/MQL/SQL milestones, without relabeling those same statuses
    // wherever they appear inside the IQL/MQL tabs' own tables.
    funnelStatusTags: { 'Meeting booked': 'IQL', 'Meeting Executed': 'MQL', 'Converted': 'SQL' },
    // A blank Sub Lead Source means the lead came in without any sub-source
    // tagging at all -- i.e. straight inbound, not attributable to a specific
    // channel. Only the Leads tab's rowField (Sub Lead Source) gets this
    // label; IQL/MQL's blank row-dimension values (LeadSource/Owner Team)
    // still fall back to the generic '-'.
    blankRowDimLabel: 'Inbound Leads',
  },
  iql: {
    label: 'IQL', rowField: 'LeadSource', rowFieldLabel: 'Lead Source',
    chartMode: 'simple', dateField: 'Meeting_Booked_Date__c', dateFieldLabel: 'Meeting Booked Date',
    outerField: 'quarter', metrics: METRICS_FULL,
  },
  mql: {
    label: 'MQL', rowField: 'Owner_Team__c', rowFieldLabel: 'Owner Team',
    chartMode: 'simple', dateField: 'Meeting_Executed_Date__c', dateFieldLabel: 'Meeting Executed Date',
    outerField: 'row', metrics: METRICS_MQL,
  },
  // SQL is NOT built from this generic Lead-based config at all -- it's a
  // different object (Opportunity/OpportunityLineItem/Account, report type
  // "Opportunities with Products"), with no Lead Status cross-tab, 6 metrics
  // instead of 2-3, and a 3-level row hierarchy with two subtotal levels. See
  // buildSqlStage below, SQL_REGION_CONFIG, and its dedicated dispatch in the
  // handler.
};

const REGION_STAGE_OVERRIDES = {
  SEA: {
    // SEA's IQL groups by Owner Team, not Lead Source.
    iql: { rowField: 'Owner_Team__c', rowFieldLabel: 'Owner Team' },
    // SEA's MQL keeps Quarter as the outer column (unlike India's reversal).
    mql: { outerField: 'quarter' },
  },
  EU: {
    // EU's IQL groups by Owner Team, not Lead Source (same shape as SEA).
    iql: { rowField: 'Owner_Team__c', rowFieldLabel: 'Owner Team' },
    // EU's MQL keeps Quarter as the outer column (same shape as SEA).
    mql: { outerField: 'quarter' },
  },
};

function getStageConfig(region, stageKey) {
  return { ...STAGE_DEFAULTS[stageKey], ...((REGION_STAGE_OVERRIDES[region] || {})[stageKey] || {}) };
}

// SQL's KPI tiles vary by region too -- SEA's report has no "Total Factors
// SDR Tracker" tile at all (only 5 tiles vs. India's 6). Kept exactly as each
// report shows it rather than forcing a uniform tile set.
// SEA's SQL report filters on "SQL Change Date: Current FY" -- the same
// dynamic fiscal-year-to-date window as India's SQL report, driven by the
// shared date-range picker like every other tab. (Earlier this was
// mis-implemented as a fixed prior-FY window; corrected after the user
// confirmed the report's actual filter text.)
const SQL_REGION_CONFIG = {
  India: { kpiKeys: ['recordCount', 'opportunityCount', 'engagementScore', 'sdrTracker', 'mrr', 'arr'], chartMetric: 'opportunityCount' },
  SEA: {
    kpiKeys: ['recordCount', 'engagementScore', 'mrr', 'opportunityCount', 'arr'],
    // SEA's chart is "Sum of Product Amount(MRR)", not opportunity count.
    chartMetric: 'mrr',
  },
  // EU's SQL report filters on "SQL Change Date: Previous FY (01-Apr-2025 -
  // 31-Mar-2026)" -- a genuinely FIXED window (unlike SEA's dynamic Current
  // FY). Verified live: 0 matching opportunities currently exist in that
  // window. kpiKeys/chartMetric default to India's full tile set since the
  // user hasn't yet shared the EU SQL report's actual KPI tiles/chart --
  // flagged for confirmation once EU has real SQL data to check against.
  EU: {
    kpiKeys: ['recordCount', 'opportunityCount', 'engagementScore', 'sdrTracker', 'mrr', 'arr'],
    chartMetric: 'opportunityCount',
    fixedDateRange: ['2025-04-01', '2026-03-31'],
  },
};

const findCol = (headers, name) => headers.findIndex(h => (h || '').toString().trim().toLowerCase() === name.toLowerCase());

// Google Sheets serial dates (day count since 1899-12-30) show up when a column
// is date-formatted; plain strings show up otherwise. Both are normalized to a
// UTC-midnight timestamp so range comparisons never drift on timezone.
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

function dayTS(dateStr) {
  const d = new Date(dateStr);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function inRange(ts, startTS, endTS) {
  return ts !== null && ts >= startTS && ts <= endTS;
}

// India's fiscal year: Q1 = Apr-Jun, Q2 = Jul-Sep, Q3 = Oct-Dec, Q4 = Jan-Mar
// (Jan-Mar belongs to the FY that started the previous April) -- matches the
// "Q1 FY2026" / "Q2 FY2026" labels in the source Salesforce reports.
function fyQuarterLabel(ts) {
  const d = new Date(ts);
  const month = d.getUTCMonth();
  const year = d.getUTCFullYear();
  if (month >= 3 && month <= 5) return `Q1 FY${year}`;
  if (month >= 6 && month <= 8) return `Q2 FY${year}`;
  if (month >= 9 && month <= 11) return `Q3 FY${year}`;
  return `Q4 FY${year - 1}`;
}

function fyQuarterSort(label) {
  const [q, fy] = label.split(' FY');
  return Number(fy) * 10 + Number(q[1]);
}

// Lead.Status picklist, in Salesforce's own metadata-defined order (the report's
// "sorted by Lead Status, ascending picklist order"). The API value and its
// display label differ for one entry: 'Disqualified MQL' is labeled
// "Disqualified Lead" in this org -- verified against the report's column header.
const STATUS_DEFS = [
  ['Registered', 'Registered'],
  ['Asset Download', 'Asset Download'],
  ['Event attendee Open', 'Event attendee Open'],
  ['Event attendee Closed', 'Event attendee Closed'],
  ['Open - Not Contacted', 'Open - Not Contacted'],
  // SEA's org data uses this value with no hyphen -- a genuinely distinct
  // literal string from 'Open - Not Contacted' above, kept as its own column
  // rather than merged/normalized (verified live: India/EU use the hyphenated
  // form, SEA does not).
  ['Open Not Contacted', 'Open Not Contacted'],
  ['Attempting Contact', 'Attempting Contact'],
  ['Engaged Lead', 'Engaged Lead'],
  ['Meeting booked', 'Meeting booked'],
  ['Meeting Executed', 'Meeting Executed'],
  ['Disqualified MQL', 'Disqualified Lead'],
  ['Converted', 'Converted'],
];
const STATUS_LABEL = new Map(STATUS_DEFS);
const STATUS_RANK = new Map(STATUS_DEFS.map(([v], i) => [v, i]));

function emptyCell() {
  return { leadAge: 0, ndl: 0, count: 0 };
}
function addToCell(cell, leadAge, isNdl) {
  cell.leadAge += leadAge;
  cell.ndl += isNdl ? 1 : 0;
  cell.count += 1;
}

function outerInnerLabels(stageCfg) {
  return stageCfg.outerField === 'row'
    ? { outerLabel: stageCfg.rowFieldLabel, innerLabel: stageCfg.dateFieldLabel }
    : { outerLabel: stageCfg.dateFieldLabel, innerLabel: stageCfg.rowFieldLabel };
}

function emptyStageResult(stageCfg) {
  return {
    totalRecords: 0, totalLeadAge: 0, totalNDL: 0,
    chartMode: stageCfg.chartMode, dateAxisLabel: stageCfg.dateFieldLabel,
    subSourceOrder: [], chart: [],
    pivot: { statusColumns: [], rows: [], columnTotals: [], grandTotal: emptyCell(), metrics: stageCfg.metrics, ...outerInnerLabels(stageCfg) },
  };
}

function buildStage(rows, startTS, endTS, stageCfg) {
  if (rows.length < 2) return emptyStageResult(stageCfg);

  const h = rows[0] || [];
  const cols = {
    createdDate: findCol(h, stageCfg.dateField),
    rowDim: findCol(h, stageCfg.rowField),
    ndl: findCol(h, 'NDL__c'),
    status: findCol(h, 'Status'),
    leadAge: findCol(h, 'Lead_age__c'),
  };

  let totalRecords = 0;
  let totalLeadAge = 0;
  let totalNDL = 0;
  const byQuarterRowDim = new Map(); // quarter -> Map(rowDimValue -> count)
  const rowDimTotals = new Map();

  // Pivot: quarter -> rowDimValue -> status -> {leadAge, ndl, count}
  const pivotCells = new Map();
  const rowTotals = new Map(); // `${quarter}||${rowDimValue}` -> cell
  const colTotals = new Map(); // status -> cell
  const grandTotal = emptyCell();
  const statusesSeen = new Set();

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const ts = parseDate(row[cols.createdDate]);
    if (!inRange(ts, startTS, endTS)) continue;

    // Lead_age__c is a stored Salesforce field (not recalculated live) --
    // summing today's-date minus CreatedDate drifts from the report, especially
    // for Converted leads whose age appears to freeze rather than keep growing.
    const leadAge = parseFloat(row[cols.leadAge]) || 0;
    const isNdl = (row[cols.ndl] || '').toString().trim().toLowerCase() === 'true';

    totalRecords += 1;
    totalLeadAge += leadAge;
    if (isNdl) totalNDL += 1;

    const rowDimValue = (row[cols.rowDim] || '').toString().trim() || (stageCfg.blankRowDimLabel || '-');
    const quarter = fyQuarterLabel(ts);
    if (!byQuarterRowDim.has(quarter)) byQuarterRowDim.set(quarter, new Map());
    const qMap = byQuarterRowDim.get(quarter);
    qMap.set(rowDimValue, (qMap.get(rowDimValue) || 0) + 1);
    rowDimTotals.set(rowDimValue, (rowDimTotals.get(rowDimValue) || 0) + 1);

    const status = (row[cols.status] || '').toString().trim() || '-';
    statusesSeen.add(status);

    if (!pivotCells.has(quarter)) pivotCells.set(quarter, new Map());
    const qPivot = pivotCells.get(quarter);
    if (!qPivot.has(rowDimValue)) qPivot.set(rowDimValue, new Map());
    const rPivot = qPivot.get(rowDimValue);
    if (!rPivot.has(status)) rPivot.set(status, emptyCell());
    addToCell(rPivot.get(status), leadAge, isNdl);

    const rowKey = `${quarter}||${rowDimValue}`;
    if (!rowTotals.has(rowKey)) rowTotals.set(rowKey, emptyCell());
    addToCell(rowTotals.get(rowKey), leadAge, isNdl);

    if (!colTotals.has(status)) colTotals.set(status, emptyCell());
    addToCell(colTotals.get(status), leadAge, isNdl);

    addToCell(grandTotal, leadAge, isNdl);
  }

  // Stable category order across quarters (by overall volume) so a row
  // dimension value keeps the same color/position everywhere, not reshuffled.
  const subSourceOrder = [...rowDimTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name);

  const quarters = [...byQuarterRowDim.keys()].sort((a, b) => fyQuarterSort(a) - fyQuarterSort(b));
  const chart = quarters.map(quarter => {
    if (stageCfg.chartMode === 'simple') {
      const total = [...byQuarterRowDim.get(quarter).values()].reduce((a, b) => a + b, 0);
      return { quarter, bars: [{ subSource: 'Total', count: total }] };
    }
    return {
      quarter,
      bars: subSourceOrder
        .map(rowDimValue => ({ subSource: rowDimValue, count: byQuarterRowDim.get(quarter).get(rowDimValue) || 0 }))
        .filter(b => b.count > 0),
    };
  });

  const tags = stageCfg.funnelStatusTags || {};
  const statusColumns = [...statusesSeen]
    .sort((a, b) => (STATUS_RANK.get(a) ?? 99) - (STATUS_RANK.get(b) ?? 99))
    .map(value => {
      const baseLabel = STATUS_LABEL.get(value) || value;
      const tag = tags[value];
      return { value, label: tag ? `${baseLabel} (${tag})` : baseLabel };
    });

  // Row hierarchy: Leads/IQL/SQL nest rowDim inside Quarter (Quarter is the
  // merged/rowspan-ed outer column); MQL reverses this -- Quarter nests inside
  // the row dimension (Owner Team is the merged outer column) -- matching
  // each report's own "sorted by X" axis exactly. `quarter`/`subSource` below
  // are reused as generic outer/inner slots so the frontend's rendering
  // (which rowspans on `.quarter` and shows `.subSource` beside it) works
  // unchanged regardless of which field is actually outermost.
  const pivotRows = [];
  if (stageCfg.outerField === 'row') {
    const outerValues = [...rowDimTotals.keys()].sort((a, b) => a.localeCompare(b));
    for (const rowDimValue of outerValues) {
      const innerQuarters = quarters.filter(q => (pivotCells.get(q) || new Map()).has(rowDimValue));
      for (const quarter of innerQuarters) {
        const rPivot = pivotCells.get(quarter).get(rowDimValue);
        pivotRows.push({
          quarter: rowDimValue,
          subSource: quarter,
          cells: statusColumns.map(({ value }) => rPivot.get(value) || emptyCell()),
          rowTotal: rowTotals.get(`${quarter}||${rowDimValue}`),
        });
      }
    }
  } else {
    for (const quarter of quarters) {
      const rowDimValues = [...rowDimTotals.keys()]
        .filter(v => (pivotCells.get(quarter) || new Map()).has(v))
        .sort((a, b) => subSourceOrder.indexOf(a) - subSourceOrder.indexOf(b));
      for (const rowDimValue of rowDimValues) {
        const rPivot = pivotCells.get(quarter).get(rowDimValue);
        pivotRows.push({
          quarter,
          subSource: rowDimValue,
          cells: statusColumns.map(({ value }) => rPivot.get(value) || emptyCell()),
          rowTotal: rowTotals.get(`${quarter}||${rowDimValue}`),
        });
      }
    }
  }

  const pivot = {
    statusColumns,
    rows: pivotRows,
    columnTotals: statusColumns.map(({ value }) => colTotals.get(value) || emptyCell()),
    grandTotal,
    metrics: stageCfg.metrics,
    ...outerInnerLabels(stageCfg),
  };

  return {
    totalRecords, totalLeadAge, totalNDL,
    chartMode: stageCfg.chartMode, dateAxisLabel: stageCfg.dateFieldLabel,
    subSourceOrder, chart, pivot,
  };
}

// -- SQL stage: OpportunityLineItem, report type "Opportunities with
// Products". Genuinely different shape from Leads/IQL/MQL: no Lead Status
// cross-tab (6 plain metric columns instead), and a 3-level row hierarchy
// (Quarter -> Opportunity Source -> Opportunity Sub Source) with a subtotal
// row after each Source group AND after each Quarter group, ending in one
// grand Total row. Two of the six metrics (Factors Engagement Score, Factors
// SDR Tracker) live on the Account and are duplicated across every line item
// of the same Opportunity -- they must be deduped by OpportunityId before
// summing, or they'd be counted once per product instead of once per deal
// (verified: summing raw gave 318 vs the report's 123; deduping by
// Opportunity gave exactly 123).
const SQL_SOURCE_ORDER = [
  'ABM', 'Growth Marketing', 'Inbound Lead', 'SDR Generated', 'Sales Generated',
  'Partner Generated', 'ABM Safal Imperia', 'Event', 'LinkedIn Sales Navigator',
  'US ABM', 'Intercom', 'Insent', 'US SEM', 'BDR Generated', 'Digital Agency',
  'Partner Co-Marketing', 'Field Campaign', 'Agentic CMO', 'Inbound SDR',
  'Digital', 'Factors Engaged', 'Influ 2 Engaged',
];
const SQL_SUBSOURCE_ORDER = [
  'Website / SEO', 'Webinar', 'Podcast', 'Industry Event', 'Netcore organized Event / Workshop',
  'Offline Event', 'Paid Advertising', 'Remarketing', 'Free Social Media Marketing',
  'Paid Social Media Advertising', 'Email Marketing', '3rd Party Events', 'Netcore Events',
  'Social Media Marketing', 'Partner Provided', 'Influencer / Analyst Generated',
  'Search Marketing', 'Referral', 'Blog / Blog Subscribers', 'Google Ads', 'Hansel Website',
  'Lead Gen Partner/Agency', 'Start-up Lp', 'ABM', 'Chatbot', 'Recotap Demo', 'Recotap Download',
  'Rollworks Demo', 'Rollworks Download', 'Webinar Attended', 'Webinar Non-Attendee',
  'Insent Chat', 'LinkedIn Demo', 'LinkedIn Download', 'Content Syndication Demo',
  'Content Syndication Download', 'Influ2 Download', 'Influ2 Demo', 'P&A Partner Event India',
  'P&A Partner Event EM', 'Webinar Demo', 'Email Demo', 'Seamless.AI', 'Direct Mailer',
  'Pathfactory Demo', 'Incoming Call', 'UNBXD India', 'Income Email', 'Google Natural Search',
  'Bing Natural Search', 'CRS', 'EmailDojo', 'WhatsApp', 'BDR Generated',
  'Outsourced agency (Penny Backer)', 'Partner Supported', 'CSM', 'GCP supported',
  'P&A Partner Event Latam', 'GCP Generated', 'MGS', 'Digital Agency', 'Events (GCP)',
  'Events', 'MDR', 'SDR', 'Facebook',
];
const SQL_SOURCE_RANK = new Map(SQL_SOURCE_ORDER.map((v, i) => [v, i]));
const SQL_SUBSOURCE_RANK = new Map(SQL_SUBSOURCE_ORDER.map((v, i) => [v, i]));

function emptySqlMetrics() {
  return { engagementScore: 0, mrr: 0, opportunityCount: 0, sdrTracker: 0, arr: 0, recordCount: 0 };
}

// Sums a set of line items, deduping the Account-level fields by Opportunity.
function sumSqlLineItems(items) {
  const m = emptySqlMetrics();
  const seenOpp = new Map(); // OpportunityId -> {engagementScore, sdrTracker}
  for (const item of items) {
    m.recordCount += 1;
    m.mrr += item.mrr;
    m.arr += item.arr;
    if (!seenOpp.has(item.oppId)) seenOpp.set(item.oppId, { engagementScore: item.engagementScore, sdrTracker: item.sdrTracker });
  }
  m.opportunityCount = seenOpp.size;
  for (const { engagementScore, sdrTracker } of seenOpp.values()) {
    m.engagementScore += engagementScore;
    if (sdrTracker) m.sdrTracker += 1;
  }
  return m;
}

function emptySqlStageResult(regionCfg) {
  return {
    totalRecords: 0, chartMode: 'breakdown', dateAxisLabel: 'SQL Change Date',
    kpiKeys: regionCfg.kpiKeys, fixedDateRange: regionCfg.fixedDateRange || null, subSourceOrder: [], chart: [],
    table: { columns: SQL_METRIC_COLUMNS, rows: [], grandTotal: emptySqlMetrics() },
  };
}

const SQL_METRIC_COLUMNS = [
  { key: 'engagementScore', label: 'Sum of Factors Engagement Score' },
  { key: 'mrr', label: 'Sum of Product Amount(MRR)' },
  { key: 'opportunityCount', label: 'Sum of Opportunity Count' },
  { key: 'sdrTracker', label: 'Sum of Factors SDR Tracker' },
  { key: 'arr', label: 'Sum of Product Amount(ARR)' },
  { key: 'recordCount', label: 'Record Count' },
];

function buildSqlStage(rows, startTS, endTS, regionCfg) {
  if (rows.length < 2) return emptySqlStageResult(regionCfg);

  const h = rows[0] || [];
  const cols = {
    date: findCol(h, 'SQL_Change_Date__c'),
    oppId: findCol(h, 'OpportunityId'),
    source: findCol(h, 'Opportunity_Source__c'),
    subSource: findCol(h, 'Opportunity_Sub_Source__c'),
    mrr: findCol(h, 'Product_Amount_MRR__c'),
    arr: findCol(h, 'Product_Amount_ARR__c'),
    engagementScore: findCol(h, 'Factors_Engagement_Score__c'),
    sdrTracker: findCol(h, 'Factors_SDR_Tracker__c'),
  };

  const items = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const ts = parseDate(row[cols.date]);
    if (!inRange(ts, startTS, endTS)) continue;
    items.push({
      quarter: fyQuarterLabel(ts),
      source: (row[cols.source] || '').toString().trim() || '-',
      subSource: (row[cols.subSource] || '').toString().trim() || '-',
      oppId: row[cols.oppId],
      mrr: parseFloat(row[cols.mrr]) || 0,
      arr: parseFloat(row[cols.arr]) || 0,
      engagementScore: parseFloat(row[cols.engagementScore]) || 0,
      sdrTracker: (row[cols.sdrTracker] || '').toString().trim().toLowerCase() === 'true',
    });
  }

  if (!items.length) return emptySqlStageResult(regionCfg);

  // Chart: flat bars grouped by Source -> Sub Source (no quarter dimension at
  // all -- matches the report's own top chart), bar length = distinct
  // Opportunity count for that pair.
  const bySourceSub = new Map(); // source -> Map(subSource -> items[])
  for (const item of items) {
    if (!bySourceSub.has(item.source)) bySourceSub.set(item.source, new Map());
    const sMap = bySourceSub.get(item.source);
    if (!sMap.has(item.subSource)) sMap.set(item.subSource, []);
    sMap.get(item.subSource).push(item);
  }
  const subSourceOrder = [...new Set(items.map(i => i.subSource))]
    .sort((a, b) => (SQL_SUBSOURCE_RANK.get(a) ?? 999) - (SQL_SUBSOURCE_RANK.get(b) ?? 999));
  const sourcesPresent = [...bySourceSub.keys()].sort((a, b) => (SQL_SOURCE_RANK.get(a) ?? 999) - (SQL_SOURCE_RANK.get(b) ?? 999));
  // The bar metric itself differs by region: India's chart is "Sum of
  // Opportunity Count" (distinct opportunities); SEA's is "Sum of Product
  // Amount(MRR)" -- confirmed against each report's own axis label and values
  // (SEA: ABM/WhatsApp bar = 211,575 = its MRR sum, not its opportunity count
  // of 1).
  const barValue = (subItems) => regionCfg.chartMetric === 'mrr'
    ? subItems.reduce((sum, i) => sum + i.mrr, 0)
    : new Set(subItems.map(i => i.oppId)).size;
  const chart = sourcesPresent.map(source => ({
    quarter: source,
    bars: [...bySourceSub.get(source).entries()]
      .sort((a, b) => (SQL_SUBSOURCE_RANK.get(a[0]) ?? 999) - (SQL_SUBSOURCE_RANK.get(b[0]) ?? 999))
      .map(([subSource, subItems]) => ({ subSource, count: barValue(subItems) })),
  }));

  // Table: Quarter -> Source -> SubSource, three levels, subtotal after each
  // Source and after each Quarter, one grand Total row at the very end.
  const byQuarter = new Map();
  for (const item of items) {
    if (!byQuarter.has(item.quarter)) byQuarter.set(item.quarter, []);
    byQuarter.get(item.quarter).push(item);
  }
  const quarters = [...byQuarter.keys()].sort((a, b) => fyQuarterSort(a) - fyQuarterSort(b));

  const tableRows = [];
  for (const quarter of quarters) {
    const quarterItems = byQuarter.get(quarter);
    const bySource = new Map();
    for (const item of quarterItems) {
      if (!bySource.has(item.source)) bySource.set(item.source, []);
      bySource.get(item.source).push(item);
    }
    const sources = [...bySource.keys()].sort((a, b) => (SQL_SOURCE_RANK.get(a) ?? 999) - (SQL_SOURCE_RANK.get(b) ?? 999));

    let quarterRowSpan = 0;
    const quarterRowsStart = tableRows.length;

    for (const source of sources) {
      const sourceItems = bySource.get(source);
      const bySub = new Map();
      for (const item of sourceItems) {
        if (!bySub.has(item.subSource)) bySub.set(item.subSource, []);
        bySub.get(item.subSource).push(item);
      }
      const subSources = [...bySub.keys()].sort((a, b) => (SQL_SUBSOURCE_RANK.get(a) ?? 999) - (SQL_SUBSOURCE_RANK.get(b) ?? 999));

      const sourceRowsStart = tableRows.length;
      for (const subSource of subSources) {
        tableRows.push({ type: 'data', quarter, source, subSource, metrics: sumSqlLineItems(bySub.get(subSource)) });
      }
      tableRows.push({ type: 'sourceSubtotal', quarter, source, subSource: 'Subtotal', metrics: sumSqlLineItems(sourceItems) });
      const sourceRowSpan = tableRows.length - sourceRowsStart;
      tableRows[sourceRowsStart].sourceRowSpan = sourceRowSpan;
    }
    tableRows.push({ type: 'quarterSubtotal', quarter, source: 'Subtotal', subSource: '', metrics: sumSqlLineItems(quarterItems) });
    quarterRowSpan = tableRows.length - quarterRowsStart;
    tableRows[quarterRowsStart].quarterRowSpan = quarterRowSpan;
  }

  return {
    totalRecords: items.length,
    chartMode: 'breakdown',
    dateAxisLabel: 'SQL Change Date',
    kpiKeys: regionCfg.kpiKeys,
    fixedDateRange: regionCfg.fixedDateRange || null,
    subSourceOrder,
    chart,
    table: { columns: SQL_METRIC_COLUMNS, rows: tableRows, grandTotal: sumSqlLineItems(items) },
  };
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

    // Sheets that haven't been synced yet (IQL/MQL/SQL for most regions, so
    // far) don't exist as tabs -- the Sheets API 400s on an unknown range.
    // Treat that as "no data yet" rather than failing the whole request.
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

    const STAGE_KEYS = ['lead', 'iql', 'mql', 'sql'];
    const jobs = [];
    for (const [region, stageSheets] of Object.entries(REGION_SHEETS)) {
      for (const stageKey of STAGE_KEYS) {
        jobs.push({ region, stageKey, sheetName: stageSheets[stageKey] });
      }
    }
    const tabData = await Promise.all(jobs.map(j => getTab(j.sheetName)));

    const result = {};
    jobs.forEach((job, i) => {
      if (!result[job.region]) result[job.region] = {};
      result[job.region][job.stageKey] = job.stageKey === 'sql'
        ? (() => {
          const regionCfg = SQL_REGION_CONFIG[job.region] || SQL_REGION_CONFIG.India;
          const [sqlStartTS, sqlEndTS] = regionCfg.fixedDateRange
            ? [dayTS(regionCfg.fixedDateRange[0]), dayTS(regionCfg.fixedDateRange[1])]
            : [startTS, endTS];
          return { label: 'SQL', ...buildSqlStage(tabData[i], sqlStartTS, sqlEndTS, regionCfg) };
        })()
        : (() => {
          const cfg = getStageConfig(job.region, job.stageKey);
          return { label: cfg.label, ...buildStage(tabData[i], startTS, endTS, cfg) };
        })();
    });

    res.status(200).json({ startDate, endDate, regions: result, lastUpdated: new Date().toISOString() });
  } catch (err) {
    console.error('[clg-regions]', err);
    res.status(500).json({ error: err.message });
  }
}
