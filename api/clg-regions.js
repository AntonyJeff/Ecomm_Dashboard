import { google } from 'googleapis';

// One sheet per (region, stage). Rolling out stage by stage -- only the sheets
// that actually exist get real data; the rest resolve to an empty/zeroed
// response until their sync is wired up (see daily_sync.py REGION_LEAD_FILTERS
// / IQL_LEAD_FILTERS etc).
const REGION_SHEETS = {
  India: { lead: 'india_ecomm_lead', iql: 'india_ecomm_iql', mql: 'india_ecomm_mql', sql: 'india_ecomm_sql' },
  SEA: { lead: 'sea_ecomm_lead', iql: 'sea_ecomm_iql', mql: 'sea_ecomm_mql', sql: 'sea_ecomm_sql' },
  EU: { lead: 'eu_ecomm_lead', iql: 'eu_ecomm_iql', mql: 'eu_ecomm_mql', sql: 'eu_ecomm_sql' },
  // Placeholder region -- no Salesforce filter/sync built yet ("we will do
  // that for later" per user). Sheet names intentionally don't exist yet;
  // getTab()'s try/catch already treats a missing sheet as "no data" for any
  // region, so this resolves to a clean empty state everywhere automatically.
  LATAM: { lead: 'latam_ecomm_lead', iql: 'latam_ecomm_iql', mql: 'latam_ecomm_mql', sql: 'latam_ecomm_sql' },
};

// Same org domain daily_sync.py logs into (SF_LOGIN_URL there) -- a bare
// "<base>/<15-or-18-char Id>" URL redirects to that record's detail page
// regardless of Lightning vs Classic, including converted leads.
const SF_RECORD_BASE_URL = 'https://netcore.my.salesforce.com';

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
  { key: 'ndl', label: 'NDL', bold: false },
  { key: 'count', label: 'Leads', bold: true },
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
    // The Leads tab collapses every pre-funnel status (Event attendee Open,
    // Open - Not Contacted, Attempting Contact, Engaged Lead, and anything
    // else not explicitly listed here -- future/unexpected statuses fall
    // into this bucket too, staying visible instead of silently vanishing)
    // into one "Leads" column, then shows the funnel-milestone statuses as
    // their own named, IQL/MQL/SQL-tagged columns, with Disqualified last.
    // Fixed column order (not data-driven like IQL/MQL) so columns don't
    // reshuffle or disappear as the date range changes. Scoped to this stage
    // only -- IQL/MQL keep their own dynamic per-status columns untouched.
    statusGroups: {
      order: ['Leads', 'Meeting booked (IQL)', 'Meeting Executed (MQL)', 'Converted (SQL)', 'Disqualified Lead'],
      mapStatus: (status) => {
        if (status === 'Meeting booked') return 'Meeting booked (IQL)';
        if (status === 'Meeting Executed') return 'Meeting Executed (MQL)';
        if (status === 'Converted') return 'Converted (SQL)';
        if (status === 'Disqualified MQL') return 'Disqualified Lead';
        return 'Leads';
      },
    },
    // A blank Sub Lead Source means the lead came in without any sub-source
    // tagging at all -- i.e. straight inbound, not attributable to a specific
    // channel. Only the Leads tab's rowField (Sub Lead Source) gets this
    // label; IQL/MQL's blank row-dimension values (LeadSource/Owner Team)
    // still fall back to the generic '-'.
    blankRowDimLabel: 'Inbound Leads',
    // Powers the click-to-see-leads popup on this tab's Status cells (not
    // extended to IQL/MQL, which use the same buildStage() but don't need it).
    includeRecordDetail: true,
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
  // SEA's SQL report filters on "SQL Change Date: Previous FY (01-Apr-2025 -
  // 31-Mar-2026)" -- a genuinely FIXED window (same shape as EU's), not the
  // dashboard's general date-range control -- confirmed directly by the user.
  SEA: {
    kpiKeys: ['recordCount', 'engagementScore', 'mrr', 'opportunityCount', 'arr'],
    // SEA's chart is "Sum of Product Amount(MRR)", not opportunity count.
    chartMetric: 'mrr',
    fixedDateRange: ['2025-04-01', '2026-03-31'],
  },
  // EU's SQL report filters on "SQL Change Date: Previous FY (01-Apr-2025 -
  // 31-Mar-2026)" -- a genuinely FIXED window. Verified live: 0 matching
  // opportunities currently exist in that window. kpiKeys/chartMetric default
  // to India's full tile set since the user hasn't yet shared the EU SQL
  // report's actual KPI tiles/chart -- flagged for confirmation once EU has
  // real SQL data to check against.
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
  return { leadAge: 0, ndl: 0, count: 0, records: [] };
}
function addToCell(cell, leadAge, isNdl, record) {
  cell.leadAge += leadAge;
  cell.ndl += isNdl ? 1 : 0;
  cell.count += 1;
  // Only populated for stages that opt in (Leads tab's clickable Status
  // cells) and only on the per-status cell itself, never on row/column/grand
  // totals -- those stay plain numbers by design.
  if (record) cell.records.push(record);
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
    leadSource: findCol(h, 'LeadSource'),
    ndl: findCol(h, 'NDL__c'),
    status: findCol(h, 'Status'),
    leadAge: findCol(h, 'Lead_age__c'),
    id: findCol(h, 'Id'),
    name: findCol(h, 'Name'),
    company: findCol(h, 'Company'),
    title: findCol(h, 'Title'),
    // "Source" in the click-through modal -- Source__c holds the actual ad
    // campaign name in this org (same naming convention as the LinkedIn/
    // Facebook sheets, e.g. "Q127_IN_Ecomm_Retail_jew_..."); Utm_Campaign__c
    // is the fallback for leads where Source__c is blank instead.
    source: findCol(h, 'Source__c'),
    utmCampaign: findCol(h, 'Utm_Campaign__c'),
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

    // Growth Marketing leads don't carry that value in Sub_Lead_Source_
    // Category__c at all (verified live: LeadSource='Growth Marketing' leads
    // have Sub_Lead_Source_Category__c scattered across Google Ads/Website-SEO/
    // Social Media Marketing/etc, or blank) -- they were bleeding into those
    // other rows' Total Leads counts instead of their own "Growth Marketing"
    // row, while IQL/MQL/SQL (which bucket by LeadSource, not Sub Lead Source
    // Category) correctly grouped them there. Reroute by LeadSource here too,
    // so a Growth-Marketing-sourced lead lands on the same "Growth Marketing"
    // row across every column, matching the other stages' axis.
    const isGrowthMarketingLead = stageCfg.rowField === 'Sub_Lead_Source_Category__c'
      && (row[cols.leadSource] || '').toString().trim() === 'Growth Marketing';
    const rowDimValue = isGrowthMarketingLead
      ? 'Growth Marketing'
      : (row[cols.rowDim] || '').toString().trim() || (stageCfg.blankRowDimLabel || '-');
    const quarter = fyQuarterLabel(ts);
    if (!byQuarterRowDim.has(quarter)) byQuarterRowDim.set(quarter, new Map());
    const qMap = byQuarterRowDim.get(quarter);
    qMap.set(rowDimValue, (qMap.get(rowDimValue) || 0) + 1);
    rowDimTotals.set(rowDimValue, (rowDimTotals.get(rowDimValue) || 0) + 1);

    const rawStatus = (row[cols.status] || '').toString().trim() || '-';
    const status = stageCfg.statusGroups ? stageCfg.statusGroups.mapStatus(rawStatus) : rawStatus;
    statusesSeen.add(status);

    const record = stageCfg.includeRecordDetail
      ? {
          id: row[cols.id] || '',
          name: (row[cols.name] || '').toString().trim() || row[cols.id] || '(no name)',
          company: (row[cols.company] || '').toString().trim(),
          title: (row[cols.title] || '').toString().trim(),
          source: pickSourceField(row[cols.rowDim], row[cols.source], row[cols.utmCampaign]),
        }
      : null;

    if (!pivotCells.has(quarter)) pivotCells.set(quarter, new Map());
    const qPivot = pivotCells.get(quarter);
    if (!qPivot.has(rowDimValue)) qPivot.set(rowDimValue, new Map());
    const rPivot = qPivot.get(rowDimValue);
    if (!rPivot.has(status)) rPivot.set(status, emptyCell());
    addToCell(rPivot.get(status), leadAge, isNdl, record);

    // rowTotals collects records too (unlike colTotals/grandTotal below) --
    // the Leads tab's "Leads" column reuses this cell wholesale (see the
    // statusGroups override past the main loop) so its click-through shows
    // every record in the bucket, not just those whose Status maps to 'Leads'.
    const rowKey = `${quarter}||${rowDimValue}`;
    if (!rowTotals.has(rowKey)) rowTotals.set(rowKey, emptyCell());
    addToCell(rowTotals.get(rowKey), leadAge, isNdl, record);

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

  // Leads tab: fixed group order regardless of what's seen in this date range
  // (so columns don't reshuffle/disappear when the filter changes). IQL/MQL:
  // dynamic, data-driven order in Salesforce's own picklist rank, as before.
  // 'Leads' displays as "Total Leads" (the Total column duplicated it exactly
  // since this column already reuses rowTotal, so Total was dropped and this
  // column renamed instead) -- value stays 'Leads' for internal matching.
  const LEADS_COLUMN_LABEL_OVERRIDES = { Leads: 'Total Leads' };
  const statusColumns = stageCfg.statusGroups
    ? stageCfg.statusGroups.order.map(value => ({ value, label: LEADS_COLUMN_LABEL_OVERRIDES[value] || value }))
    : [...statusesSeen]
        .sort((a, b) => (STATUS_RANK.get(a) ?? 99) - (STATUS_RANK.get(b) ?? 99))
        .map(value => ({ value, label: STATUS_LABEL.get(value) || value }));

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

  const columnTotals = statusColumns.map(({ value }) => colTotals.get(value) || emptyCell());

  // Leads tab only: the "Leads" column is being rebuilt to mean "every record
  // in this bucket" (regardless of its own Status) rather than "only records
  // whose Status maps to the 'Leads' group" -- rowTotals/grandTotal already
  // accumulate unconditionally every iteration above, so swapping them in
  // here gives the full count (and, for rowTotal, the full record list) for
  // free without a second pass over the data.
  if (stageCfg.statusGroups) {
    const leadsColIdx = statusColumns.findIndex(c => c.value === 'Leads');
    if (leadsColIdx !== -1) {
      for (const row of pivotRows) row.cells[leadsColIdx] = row.rowTotal;
      columnTotals[leadsColIdx] = grandTotal;
    }
  }

  const pivot = {
    statusColumns,
    rows: pivotRows,
    columnTotals,
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

// -- Leads tab's "MRR" column: attributes each SQL opportunity's MRR back to
// the Sub Lead Source / Create Date quarter of the LEAD it converted from
// (added per user request -- confirmed: only opportunities whose SQL Change
// Date falls in the SAME selected date range count, matching how the SQL
// tab itself already scopes MRR; and this is deliberately the dollar value
// behind the existing "Converted (SQL)" leads, not an independent bucket).
// Reads the region's own SQL sheet directly rather than SQL's own pivot
// output, since Lead_Sub_Lead_Source_Category__c/Lead_CreatedDate (added to
// daily_sync.py's SQL sync for exactly this) aren't part of that pivot.
// Leads tab Converted (SQL) column + MRR column: both computed in one pass
// over the SQL sheet (OpportunityLineItem rows, deduped by OpportunityId --
// "multiple line items per opportunity" would otherwise double/triple count
// both the deal and its revenue). Both inclusion AND the bucket's quarter
// come from SQL_Change_Date__c (matching IQL/MQL's own-date-field pattern --
// NOT the originating lead's CreatedDate, which can land in an earlier
// quarter than the actual conversion; confirmed live, 13/25 India SQL line
// items have a Lead_CreatedDate quarter different from their SQL_Change_Date
// quarter, including one lead created Dec 2025 that converted Apr 2026).
// LeadSource (mapped through mapLeadSourceToBucket below, matching IQL/MQL's
// axis) is still traced back via Lead_LeadSource, added to the sheet at sync
// time. Opportunities with no traceable lead are excluded rather than
// guessed at.
function computeSqlByRow(sqlRows, startTS, endTS) {
  const byRow = new Map(); // `${quarter}||${subSource}` -> { mrr, cell }
  if (sqlRows.length < 2) return byRow;

  const h = sqlRows[0];
  const cols = {
    oppId: findCol(h, 'OpportunityId'),
    sqlChangeDate: findCol(h, 'SQL_Change_Date__c'),
    mrr: findCol(h, 'Product_Amount_MRR__c'),
    leadSource: findCol(h, 'Lead_LeadSource'),
    leadCreatedDate: findCol(h, 'Lead_CreatedDate'),
    oppName: findCol(h, 'Opportunity_Name'),
    accountName: findCol(h, 'Account_Name'),
  };

  const perOpp = new Map(); // OpportunityId -> { mrr, quarter, subSource, name, company }
  for (let i = 1; i < sqlRows.length; i++) {
    const row = sqlRows[i];
    const ts = parseDate(row[cols.sqlChangeDate]);
    if (!inRange(ts, startTS, endTS)) continue;

    const oppId = row[cols.oppId];
    if (!oppId) continue;

    const leadCreatedTs = parseDate(row[cols.leadCreatedDate]);
    if (leadCreatedTs === null) continue;

    const subSource = mapLeadSourceToBucket(row[cols.leadSource]);
    const quarter = fyQuarterLabel(ts);
    const mrrVal = parseFloat(row[cols.mrr]) || 0;

    if (!perOpp.has(oppId)) {
      perOpp.set(oppId, {
        mrr: 0, quarter, subSource,
        name: (row[cols.oppName] || '').toString().trim() || oppId,
        company: (row[cols.accountName] || '').toString().trim(),
      });
    }
    perOpp.get(oppId).mrr += mrrVal; // multiple line items per opportunity
  }

  for (const [oppId, opp] of perOpp) {
    const key = `${opp.quarter}||${opp.subSource}`;
    if (!byRow.has(key)) byRow.set(key, { mrr: 0, cell: emptyCell() });
    const entry = byRow.get(key);
    entry.mrr += opp.mrr;
    addToCell(entry.cell, 0, false, { id: oppId, name: opp.name, company: opp.company, title: '' });
  }
  return byRow;
}

// The Leads tab's own report groups rows by Sub_Lead_Source_Category__c, but
// the IQL/MQL/SQL reports group by the STANDARD LeadSource field instead --
// a genuinely different axis, confirmed live against the actual IQL report
// (India Q1 FY2026: Inbound Lead=13, matching exactly). LeadSource values
// blank/'Inbound Lead'/'Intercom'/'Insent/ChatBot' all fold into "Inbound
// Leads" (matching the Leads tab's own bucket name); every other value
// (ABM, Growth Marketing, Factors Engaged, ...) is its own row.
const INBOUND_LEAD_SOURCE_VALUES = new Set(['', 'Inbound Lead', 'Intercom', 'Insent/ChatBot']);
function mapLeadSourceToBucket(leadSource) {
  const trimmed = (leadSource || '').toString().trim();
  return INBOUND_LEAD_SOURCE_VALUES.has(trimmed) ? 'Inbound Leads' : trimmed;
}

// Click-through modal's "Source" field: normally Source__c (the actual ad
// campaign name in this org), falling back to Utm_Campaign__c when blank.
// Google Ads leads are the one exception -- confirmed live, Source__c only
// holds the generic landing-page URL for these (e.g.
// "http://netcorecloud.com/lp/in/brand-1/"), never a campaign name, while
// Utm_Campaign__c has the real one -- so Google Ads leads use
// Utm_Campaign__c as the PRIMARY field instead, not just as a blank-fallback.
function pickSourceField(subLeadSource, sourceVal, utmCampaignVal) {
  const source = (sourceVal || '').toString().trim();
  const utmCampaign = (utmCampaignVal || '').toString().trim();
  const isGoogleAds = (subLeadSource || '').toString().trim() === 'Google Ads';
  return isGoogleAds ? (utmCampaign || source) : (source || utmCampaign);
}

// Leads tab IQL/MQL columns: same idea as computeSqlByRow below, but these
// are still plain Lead-object sheets (IQL/MQL sync fetches the same Lead
// fields as Leads, just windowed on a different date field) -- no
// OpportunityId trace-back needed, LeadSource/records are right there on
// each row already. Both inclusion AND the bucket's quarter come from that
// STAGE's own natural date field (Meeting_Booked_Date__c /
// Meeting_Executed_Date__c) -- matching the report's own quarter axis
// exactly. (Deliberately NOT the lead's CreatedDate: confirmed live, India
// IQL Q1 FY2026 ABM is 4 by CreatedDate but 5 by Meeting_Booked_Date__c, and
// the real report shows 5 -- a lead's CreatedDate and its Meeting Booked/
// Executed Date can fall in different quarters.)
function computeStageCountByRow(stageRows, dateFieldName, startTS, endTS) {
  const byRow = new Map(); // `${quarter}||${subSource}` -> cell
  if (stageRows.length < 2) return byRow;

  const h = stageRows[0];
  const cols = {
    dateField: findCol(h, dateFieldName),
    leadSource: findCol(h, 'LeadSource'),
    ndl: findCol(h, 'NDL__c'),
    id: findCol(h, 'Id'),
    name: findCol(h, 'Name'),
    company: findCol(h, 'Company'),
    title: findCol(h, 'Title'),
    source: findCol(h, 'Source__c'),
    utmCampaign: findCol(h, 'Utm_Campaign__c'),
    subLeadSource: findCol(h, 'Sub_Lead_Source_Category__c'),
  };

  for (let i = 1; i < stageRows.length; i++) {
    const row = stageRows[i];
    const ts = parseDate(row[cols.dateField]);
    if (!inRange(ts, startTS, endTS)) continue;

    const subSource = mapLeadSourceToBucket(row[cols.leadSource]);
    const quarter = fyQuarterLabel(ts);
    const isNdl = (row[cols.ndl] || '').toString().trim().toLowerCase() === 'true';

    const key = `${quarter}||${subSource}`;
    if (!byRow.has(key)) byRow.set(key, emptyCell());
    addToCell(byRow.get(key), 0, isNdl, {
      id: row[cols.id] || '',
      name: (row[cols.name] || '').toString().trim() || row[cols.id] || '(no name)',
      company: (row[cols.company] || '').toString().trim(),
      source: pickSourceField(row[cols.subLeadSource], row[cols.source], row[cols.utmCampaign]),
      title: (row[cols.title] || '').toString().trim(),
    });
  }
  return byRow;
}

// A bucket (quarter + Sub Lead Source) can have real IQL/MQL/SQL data with
// ZERO rows in the Leads sheet itself (e.g. a Sub Lead Source Category that
// only ever shows up on meetings/opportunities, never on a fresh lead --
// confirmed live: India's MQL sheet has 'Email Marketing' and 'First party
// webinar' categories that don't exist anywhere in its Leads sheet). Without
// this, such buckets would be silently dropped from the table entirely even
// though their IQL/MQL/SQL counts are real -- this adds a Leads=0 row for
// any bucket seen in the given maps but missing from the pivot already.
// Must run BEFORE the injectStageCountColumn/injectMrrColumn calls below,
// so the newly-added rows are present to receive their cell values.
//
// Restricted to quarters inside the currently selected [startTS, endTS]
// window -- SQL's own fixed prior-FY window can trace an opportunity back to
// a lead created well before the dashboard's selected range (e.g. Q3/Q4
// FY2025 while viewing Q1/Q2 FY2026), and those are out of scope for now.
// This isn't a hardcoded quarter list -- it tracks whatever range is
// selected, so widening the dashboard's date picker later naturally admits
// more quarters without a code change.
// Drops any bucket whose quarter falls outside [startTS, endTS] -- applied to
// the IQL/MQL/SQL byRow maps BEFORE both mergeExtraBuckets and the inject*
// calls, so an out-of-range quarter (e.g. SQL tracing back to a lead created
// before the dashboard's selected window) is excluded from the grand totals
// too, not just hidden as a row -- otherwise the footer would show money/
// counts that don't correspond to anything visible in the table.
function filterMapToQuarterRange(map, startTS, endTS) {
  const minQ = fyQuarterSort(fyQuarterLabel(startTS));
  const maxQ = fyQuarterSort(fyQuarterLabel(endTS));
  const filtered = new Map();
  for (const [key, value] of map) {
    const quarter = key.slice(0, key.indexOf('||'));
    const q = fyQuarterSort(quarter);
    if (q >= minQ && q <= maxQ) filtered.set(key, value);
  }
  return filtered;
}

function mergeExtraBuckets(stageResult, extraByRowMaps, startTS, endTS) {
  const { pivot, subSourceOrder } = stageResult;
  const seenKeys = new Set(pivot.rows.map(r => `${r.quarter}||${r.subSource}`));
  const minQ = fyQuarterSort(fyQuarterLabel(startTS));
  const maxQ = fyQuarterSort(fyQuarterLabel(endTS));

  for (const map of extraByRowMaps) {
    for (const key of map.keys()) {
      if (seenKeys.has(key)) continue;
      const sep = key.indexOf('||');
      const quarter = key.slice(0, sep);
      const q = fyQuarterSort(quarter);
      if (q < minQ || q > maxQ) continue;
      seenKeys.add(key);
      const subSource = key.slice(sep + 2);
      pivot.rows.push({
        quarter, subSource,
        cells: pivot.statusColumns.map(() => emptyCell()),
        rowTotal: emptyCell(),
      });
      if (!subSourceOrder.includes(subSource)) subSourceOrder.push(subSource);
    }
  }

  pivot.rows.sort((a, b) =>
    fyQuarterSort(a.quarter) - fyQuarterSort(b.quarter)
    || subSourceOrder.indexOf(a.subSource) - subSourceOrder.indexOf(b.subSource)
  );
}

// Overwrites an existing Leads-tab status column's cells wholesale with
// counts computed from a different sheet entirely (the IQL or MQL sheet) --
// unlike injectMrrColumn, this replaces a column that's already in
// statusColumns rather than splicing in a new one.
function injectStageCountColumn(pivot, columnLabel, countByRow) {
  const idx = pivot.statusColumns.findIndex(c => c.label === columnLabel);
  if (idx === -1) return;

  pivot.rows.forEach(row => {
    row.cells[idx] = countByRow.get(`${row.quarter}||${row.subSource}`) || emptyCell();
  });

  const grand = emptyCell();
  for (const cell of countByRow.values()) {
    grand.count += cell.count;
    grand.ndl += cell.ndl;
    // Deliberately no records on the grand total -- same convention as every
    // other column/grand total cell (only per-bucket cells carry records).
  }
  pivot.columnTotals[idx] = grand;
}

// Splices an "MRR" pseudo-column into an already-built Leads-tab pivot,
// positioned right after "Converted (SQL)". Deliberately NOT folded into
// rowTotal/columnTotals/grandTotal -- those represent lead counts, and MRR is
// a dollar amount, so adding it in would silently corrupt the Total column.
function injectMrrColumn(pivot, sqlByRow) {
  const convertedIdx = pivot.statusColumns.findIndex(c => c.value === 'Converted (SQL)');
  const insertAt = convertedIdx === -1 ? pivot.statusColumns.length : convertedIdx + 1;

  pivot.statusColumns.splice(insertAt, 0, { value: '__mrr__', label: 'MRR', isMrr: true });
  pivot.rows.forEach(row => {
    const entry = sqlByRow.get(`${row.quarter}||${row.subSource}`);
    row.cells.splice(insertAt, 0, { mrr: entry ? entry.mrr : 0, records: [] });
  });
  let grandMrr = 0;
  for (const { mrr } of sqlByRow.values()) grandMrr += mrr;
  pivot.columnTotals.splice(insertAt, 0, { mrr: grandMrr, records: [] });
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
    mrrTrend: [],
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

  // MRR trend -- one point per quarter (Sum of Product Amount(MRR) across
  // every Source/SubSource for that quarter), for the Trends tab's MRR chart.
  const mrrTrend = quarters.map(quarter => ({ quarter, mrr: sumSqlLineItems(byQuarter.get(quarter)).mrr }));

  return {
    totalRecords: items.length,
    chartMode: 'breakdown',
    dateAxisLabel: 'SQL Change Date',
    kpiKeys: regionCfg.kpiKeys,
    fixedDateRange: regionCfg.fixedDateRange || null,
    subSourceOrder,
    chart,
    mrrTrend,
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
          const stageResult = buildStage(tabData[i], startTS, endTS, cfg);
          if (job.stageKey === 'lead') {
            const iqlIdx = jobs.findIndex(j => j.region === job.region && j.stageKey === 'iql');
            const iqlByRow = computeStageCountByRow(tabData[iqlIdx], 'Meeting_Booked_Date__c', startTS, endTS);

            const mqlIdx = jobs.findIndex(j => j.region === job.region && j.stageKey === 'mql');
            const mqlByRow = computeStageCountByRow(tabData[mqlIdx], 'Meeting_Executed_Date__c', startTS, endTS);

            // SQL's own date window can be a fixed prior-FY range (SEA/EU),
            // not the general dashboard range -- match whatever that region's
            // own SQL tab uses, or these would silently show 0 outside it.
            const sqlIdx = jobs.findIndex(j => j.region === job.region && j.stageKey === 'sql');
            const sqlRegionCfg = SQL_REGION_CONFIG[job.region] || SQL_REGION_CONFIG.India;
            const [sqlStartTS, sqlEndTS] = sqlRegionCfg.fixedDateRange
              ? [dayTS(sqlRegionCfg.fixedDateRange[0]), dayTS(sqlRegionCfg.fixedDateRange[1])]
              : [startTS, endTS];
            const sqlByRowRaw = computeSqlByRow(tabData[sqlIdx], sqlStartTS, sqlEndTS);

            // The bucket's quarter comes from the ORIGINATING LEAD's own
            // CreatedDate, which can fall outside the general dashboard
            // window even when the stage's own date field (Meeting Booked/
            // Executed/SQL Change Date) is in range -- e.g. a lead created in
            // FY2025 with a meeting booked in the currently-selected FY2026
            // window. Dropped here so out-of-range quarters vanish from both
            // the rows AND the grand totals, not just the rows.
            const iqlByRowScoped = filterMapToQuarterRange(iqlByRow, startTS, endTS);
            const mqlByRowScoped = filterMapToQuarterRange(mqlByRow, startTS, endTS);
            const sqlByRow = filterMapToQuarterRange(sqlByRowRaw, startTS, endTS);
            const sqlCountByRow = new Map([...sqlByRow].map(([key, entry]) => [key, entry.cell]));

            // Add rows for any bucket that has IQL/MQL/SQL data but no Leads-
            // sheet rows at all, BEFORE populating the columns below.
            mergeExtraBuckets(stageResult, [iqlByRowScoped, mqlByRowScoped, sqlCountByRow], startTS, endTS);

            injectStageCountColumn(stageResult.pivot, 'Meeting booked (IQL)', iqlByRowScoped);
            injectStageCountColumn(stageResult.pivot, 'Meeting Executed (MQL)', mqlByRowScoped);
            injectStageCountColumn(stageResult.pivot, 'Converted (SQL)', sqlCountByRow);
            injectMrrColumn(stageResult.pivot, sqlByRow);
          }
          return { label: cfg.label, ...stageResult };
        })();
    });

    res.status(200).json({ startDate, endDate, regions: result, sfRecordBaseUrl: SF_RECORD_BASE_URL, lastUpdated: new Date().toISOString() });
  } catch (err) {
    console.error('[clg-regions]', err);
    res.status(500).json({ error: err.message });
  }
}
