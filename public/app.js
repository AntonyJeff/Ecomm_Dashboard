const fmtInt = (n) => Math.round(n).toLocaleString('en-IN');
const fmtDec = (n) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Counts a KPI number up/down from whatever it currently shows to `toValue`
// instead of letting the text jump straight to the new figure -- reads the
// previous value back out of the element's own text so callers don't need to
// track it separately. formatFn must accept a plain number (fmtInt/fmtDec/
// fmtCurrency all qualify); non-numeric previous text (e.g. the initial "-")
// is treated as a start value of 0.
function animateNumberText(el, toValue, formatFn = fmtInt) {
  if (!el) return;
  const prevNumeric = parseFloat((el.textContent || '').replace(/[^0-9.-]/g, ''));
  const from = Number.isFinite(prevNumeric) ? prevNumeric : 0;
  const to = Number.isFinite(toValue) ? toValue : 0;
  if (el._numAnimFrame) cancelAnimationFrame(el._numAnimFrame);
  if (from === to) { el.textContent = formatFn(to); return; }
  const duration = 500;
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = formatFn(from + (to - from) * eased);
    el._numAnimFrame = t < 1 ? requestAnimationFrame(step) : null;
  };
  el._numAnimFrame = requestAnimationFrame(step);
}

// Categorical palette (fixed order, never cycled/reassigned by rank) --
// matches the dataviz reference palette, validated for CVD-safe adjacent pairs.
const PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];

const REGIONS = [
  { key: 'India', color: PALETTE[0] },
  { key: 'SEA', color: PALETTE[1] },
  { key: 'EU', color: PALETTE[2] },
  { key: 'LATAM', color: PALETTE[3] },
  { key: 'MEA', color: PALETTE[4] },
];

// Spends is a separate ad-spend data source (api/clg-spends.js) from the
// Leads/Trends Salesforce sync above -- MEA has Email/WhatsApp spend data
// but no LinkedIn/Meta Ads spend data, independent of whether MEA has
// Salesforce CRM data (it now does, hence MEA being in REGIONS above).
const SPENDS_MESSAGING_REGIONS = REGIONS;
const SPENDS_PAID_REGIONS = REGIONS.filter(r => r.key !== 'MEA');
const MESSAGING_CHANNELS = new Set(['email', 'whatsapp']);
function spendsIsMessaging() {
  return MESSAGING_CHANNELS.has(spendsActiveChannel);
}
function spendsRegionsForChannel() {
  return spendsIsMessaging() ? SPENDS_MESSAGING_REGIONS : SPENDS_PAID_REGIONS;
}

let activeRegion = 'All';
let activeStage = 'lead';
let lastData = null;
let viewingSpends = false;

// Default view window (also what Reset returns to) -- April 1 of the current
// fiscal year (this business's FY starts in April, matching the Q1xx/Q2xx
// quarter labels used throughout) through today, computed fresh every time
// the dashboard loads rather than a hardcoded date that goes stale.
function fiscalYearStartDate() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0 = Jan .. 3 = Apr
  const fyStartYear = month >= 3 ? year : year - 1;
  return `${fyStartYear}-04-01`;
}
const DEFAULT_START_DATE = fiscalYearStartDate();
const DEFAULT_END_DATE = new Date().toISOString().slice(0, 10);
let currentStartDate = DEFAULT_START_DATE;
let currentEndDate = DEFAULT_END_DATE;

// Spends tab uses the same default window as the Leads dashboard.
const SPENDS_DEFAULT_START_DATE = DEFAULT_START_DATE;
const SPENDS_DEFAULT_END_DATE = DEFAULT_END_DATE;

const METRIC_FMT = { leadAge: fmtDec, ndl: fmtInt, count: fmtInt };

// Theme toggle -- light (default) / dark. Persisted per-browser via
// localStorage; falls back to light on first visit. There is no visible
// toggle control -- clicking the "Live" badge in the topbar switches themes.
const THEME_STORAGE_KEY = 'clg-dashboard-theme';
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
}
function initTheme() {
  const saved = localStorage.getItem(THEME_STORAGE_KEY);
  applyTheme(saved === 'dark' ? 'dark' : 'light');
  const btn = document.getElementById('themeToggle');
  if (btn) {
    btn.addEventListener('click', () => {
      const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      localStorage.setItem(THEME_STORAGE_KEY, next);
      applyTheme(next);
    });
  }
}
initTheme();

// ---- GSAP micro-interactions -- everything below degrades to plain,
// un-animated behavior if the CDN script failed to load (window.gsap
// missing), so a network hiccup never breaks the dashboard itself. ----
const gsapReady = typeof window !== 'undefined' && !!window.gsap;
if (gsapReady && window.ScrollToPlugin) gsap.registerPlugin(ScrollToPlugin);

function animateViewIn(el, fromY = 14) {
  if (!gsapReady || !el) return;
  gsap.fromTo(el, { autoAlpha: 0, y: fromY }, { autoAlpha: 1, y: 0, duration: 0.4, ease: 'power2.out' });
}

function animateRowsIn(rows) {
  if (!gsapReady || !rows || !rows.length) return;
  gsap.fromTo(rows, { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0, duration: 0.3, stagger: 0.025, ease: 'power2.out' });
}

function animateBadgesIn(badges, delay = 0.1) {
  if (!gsapReady || !badges || !badges.length) return;
  gsap.fromTo(badges, { scale: 0, autoAlpha: 0 }, { scale: 1, autoAlpha: 1, duration: 0.35, stagger: 0.02, delay, ease: 'back.out(2.2)' });
}

function pulseScale(el) {
  if (!gsapReady || !el) return;
  gsap.fromTo(el, { scale: 0.88 }, { scale: 1, duration: 0.35, ease: 'back.out(3)' });
}

function smoothScrollTop() {
  if (!gsapReady || !window.ScrollToPlugin) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  gsap.to(window, { duration: 0.6, scrollTo: 0, ease: 'power2.out' });
}

function escapeHtml(s) {
  return (s || '').toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function colorFor(subSource, subSourceOrder) {
  const i = subSourceOrder.indexOf(subSource);
  return PALETTE[i % PALETTE.length];
}

function renderLegend(subSourceOrder) {
  return subSourceOrder.map(name => `
    <span class="legend-item">
      <span class="legend-swatch" style="background:${colorFor(name, subSourceOrder)}"></span>
      ${escapeHtml(name)}
    </span>
  `).join('');
}

function renderChart(regionData, valueFmt = fmtInt) {
  const { chart, subSourceOrder, chartMode } = regionData;
  const maxCount = Math.max(1, ...chart.flatMap(q => q.bars.map(b => b.count)));
  const isSimple = chartMode === 'simple';

  return chart.map(({ quarter, bars }) => `
    <div class="quarter-group">
      <div class="quarter-label">${escapeHtml(quarter)}</div>
      ${bars.map(({ subSource, count }) => `
        <div class="bar-row${isSimple ? ' bar-row-simple' : ''}">
          ${isSimple ? '' : `<span class="bar-label" title="${escapeHtml(subSource)}">${escapeHtml(subSource)}</span>`}
          <span class="bar-track">
            <span class="bar-fill" style="width:${Math.max(2, (count / maxCount) * 100)}%; background:${isSimple ? 'var(--accent)' : colorFor(subSource, subSourceOrder)}">
              <span class="bar-value">${valueFmt(count)}</span>
            </span>
          </span>
        </div>
      `).join('')}
    </div>
  `).join('');
}

// The report renders each metric ("Sum of Lead age" / "Sum of NDL" / "Record
// Count" -- or just "Sum NDL" / "Count" for MQL) as its own LABELED row per
// group, not packed into one cell. pivot.metrics (from the API, per stage)
// drives exactly which rows appear, in the exact order and with the exact
// labels the report uses -- MQL genuinely has no Lead Age row at all.
function renderPivotHead(statusColumns, outerLabel, innerLabel) {
  return `
    <tr>
      <th class="pin pin-quarter">${escapeHtml(outerLabel)}</th>
      <th class="pin pin-subsource">${escapeHtml(innerLabel)}</th>
      <th class="pin pin-metric"></th>
      ${statusColumns.map(c => `<th>${escapeHtml(c.label)}</th>`).join('')}
    </tr>
  `;
}

// Cells only carry `records` when the stage opted into click-to-see-leads
// (Leads tab today -- see includeRecordDetail in the API). Total-column cells
// never carry records, so they're never clickable, by construction. Only the
// bold Record Count row is clickable, not Sum of NDL -- both rows read the
// same underlying cell, so a cell with leads but zero NDL-flagged ones would
// otherwise show a clickable "0" on the NDL row, which reads as a bug (the
// number shown implies nothing to see, but the click would show leads anyway).
function metricRow({ quarterCell, subSourceCell, metric, cells, statusColumns, extraClass = '', revealColumns = null, prevCells = null }) {
  const fmt = METRIC_FMT[metric.key];
  // revealColumns is a WIP staging flag (Leads-tab crosstab columns are being
  // rebuilt one at a time) -- null means "show everything" (IQL/MQL tabs,
  // untouched); a Set means only those column labels show real numbers, the
  // rest render 0 while their records/click-through stay wired up untouched.
  const isRevealed = (col) => !revealColumns || revealColumns.has(col ? col.label : null);
  return `
    <tr class="${extraClass}">
      ${quarterCell}
      ${subSourceCell}
      <td class="pin pin-metric${metric.bold ? ' pivot-cell-count' : ''}">${metric.label}</td>
      ${cells.map((cell, i) => {
        const col = statusColumns && statusColumns[i];
        const prevCell = prevCells && prevCells[i];
        // The MRR pseudo-column (Leads tab only) is a dollar amount, not a
        // lead count -- it only shows on the bold Leads row, formatted as
        // currency, and is never clickable (no per-lead breakdown for it).
        if (col && col.isMrr) {
          const val = metric.bold ? fmtCurrency(isRevealed(col) ? (cell.mrr || 0) : 0) : '';
          const delta = metric.bold && isRevealed(col) && prevCell ? deltaBadgeHtml(cell.mrr || 0, prevCell.mrr) : '';
          return `<td class="pivot-cell${metric.bold ? ' pivot-cell-count' : ''} pivot-cell-mrr">${val}${delta}</td>`;
        }
        const clickable = metric.bold && cell.records && cell.records.length > 0;
        const cls = `pivot-cell${metric.bold ? ' pivot-cell-count' : ''}${clickable ? ' pivot-cell-clickable' : ''}`;
        const statusLabel = col ? col.label : '';
        const dataAttrs = clickable
          ? ` data-records="${encodeURIComponent(JSON.stringify(cell.records))}" data-status-label="${escapeHtml(statusLabel)}"`
          : '';
        const delta = isRevealed(col) && prevCell ? deltaBadgeHtml(cell[metric.key], prevCell[metric.key]) : '';
        return `<td class="${cls}"${dataAttrs}>${isRevealed(col) ? fmt(cell[metric.key]) : fmt(0)}${delta}</td>`;
      }).join('')}
    </tr>
  `;
}

// Aggregates a comparison-period pivot's cells by row dimension (subSource)
// only, ignoring its own quarter grouping, into an array of cells index-
// aligned to statusColumns -- safe here specifically because the Leads
// stage's statusColumns come from a fixed order (stageCfg.statusGroups, see
// api/clg-regions.js) rather than being data-driven, so the current and
// comparison pivots always share the same column set/order even though their
// row sets (which quarter/subSource combos have any data) can differ. Ignoring
// quarter also means a comparison range that lands in an earlier fiscal
// quarter than the primary range still matches up correctly by subSource.
function aggregatePivotBySubSource(pivot) {
  const map = new Map();
  if (!pivot) return map;
  for (const row of pivot.rows) {
    if (!map.has(row.subSource)) {
      map.set(row.subSource, row.cells.map(() => ({ leadAge: 0, ndl: 0, count: 0, mrr: 0 })));
    }
    const agg = map.get(row.subSource);
    row.cells.forEach((cell, i) => {
      if (!agg[i]) agg[i] = { leadAge: 0, ndl: 0, count: 0, mrr: 0 };
      agg[i].leadAge += cell.leadAge || 0;
      agg[i].ndl += cell.ndl || 0;
      agg[i].count += cell.count || 0;
      agg[i].mrr += cell.mrr || 0;
    });
  }
  return map;
}

function renderPivotBody(pivot, revealColumns = null, prevPivot = null) {
  if (!pivot.rows.length) return '<tr><td colspan="99" class="empty">No matching leads in this range.</td></tr>';
  const metrics = pivot.metrics;
  const prevBySubSource = prevPivot ? aggregatePivotBySubSource(prevPivot) : null;
  // A subSource entirely absent from the comparison period (e.g. WhatsApp had
  // zero leads last week) is a real, meaningful zero -- not "no comparison
  // data available." Falling back to null here would silently suppress every
  // delta badge on that row (including ones with real current-period numbers,
  // like Total Leads/Disqualified Lead), when the correct badge is "NEW"
  // (deltaBadgeHtml already renders that for an actual 0 previous value).
  const zeroCells = () => pivot.statusColumns.map(() => ({ leadAge: 0, ndl: 0, count: 0, mrr: 0 }));

  const quarterRowCounts = new Map();
  pivot.rows.forEach(r => quarterRowCounts.set(r.quarter, (quarterRowCounts.get(r.quarter) || 0) + metrics.length));
  const seenQuarter = new Set();

  return pivot.rows.map(row => {
    const isFirstOfQuarter = !seenQuarter.has(row.quarter);
    seenQuarter.add(row.quarter);
    const prevCells = prevBySubSource ? (prevBySubSource.get(row.subSource) || zeroCells()) : null;

    return metrics.map((metric, i) => {
      const quarterCell = isFirstOfQuarter && i === 0
        ? `<td class="pin pin-quarter" rowspan="${quarterRowCounts.get(row.quarter)}">${escapeHtml(row.quarter)}</td>`
        : '';
      const subSourceCell = i === 0
        ? `<td class="pin pin-subsource" rowspan="${metrics.length}" title="${escapeHtml(row.subSource)}">${escapeHtml(row.subSource)}</td>`
        : '';
      return metricRow({ quarterCell, subSourceCell, metric, cells: row.cells, statusColumns: pivot.statusColumns, revealColumns, prevCells });
    }).join('');
  }).join('');
}

function renderPivotFoot(pivot, revealColumns = null, prevPivot = null) {
  const metrics = pivot.metrics;
  return metrics.map((metric, i) => {
    const quarterCell = i === 0 ? `<td class="pin pin-quarter" rowspan="${metrics.length}">Total</td>` : '';
    const subSourceCell = i === 0 ? `<td class="pin pin-subsource" rowspan="${metrics.length}"></td>` : '';
    return metricRow({ quarterCell, subSourceCell, metric, cells: pivot.columnTotals, statusColumns: pivot.statusColumns, extraClass: 'pivot-total-row', revealColumns, prevCells: prevPivot ? prevPivot.columnTotals : null });
  }).join('');
}

// Funnel View (the only stage renderRegion is called for now that IQL/MQL/
// SQL live under the Trends tab instead) -- table only, no KPI tiles (an
// exact duplicate of the top overview bento boxes) and no chart (moved to
// Trends alongside IQL/MQL/SQL's charts).
function renderRegion(region, stage, data, prevPivot = null) {
  const template = document.getElementById('region-template');
  const node = template.content.cloneNode(true);

  node.querySelector('.region-kpi-row').classList.add('hidden');
  node.querySelector('.funnel-chart-wrap').classList.add('hidden');
  node.querySelector('.pivot-title').textContent = `${data.pivot.outerLabel} > ${data.pivot.innerLabel} × Lead Status`;

  // WIP: the Leads tab's crosstab columns (Leads/IQL/MQL/SQL/MRR/Disqualified)
  // are being rebuilt one at a time to each pull from that stage's own filter
  // instead of one shared dataset. "Leads" is live now (full record count per
  // bucket, not just Status-mapped-to-Leads); everything else still shows 0
  // until its turn, while the click-to-see-leads records stay wired up.
  const revealColumns = stage === 'lead'
    ? new Set(['Total Leads', 'Meeting booked (IQL)', 'Meeting Executed (MQL)', 'Converted (SQL)', 'MRR', 'Disqualified Lead'])
    : null;
  node.querySelector('.pivot-table thead').innerHTML = renderPivotHead(data.pivot.statusColumns, data.pivot.outerLabel, data.pivot.innerLabel);
  node.querySelector('.pivot-table tbody').innerHTML = renderPivotBody(data.pivot, revealColumns, prevPivot);
  node.querySelector('.pivot-table tfoot').innerHTML = data.pivot.rows.length ? renderPivotFoot(data.pivot, revealColumns, prevPivot) : '';

  return node;
}

// ---- SQL stage rendering (Opportunity/OpportunityLineItem/Account -- a
// different shape entirely: 6 plain metric columns, no Lead Status cross-tab,
// 3-level row hierarchy with two subtotal levels). ----

const fmtCurrency = (n) => '₹' + Math.round(n).toLocaleString('en-IN');
const SQL_METRIC_FMT = { engagementScore: fmtInt, mrr: fmtCurrency, opportunityCount: fmtInt, sdrTracker: fmtInt, arr: fmtCurrency, recordCount: fmtInt };
// Not every region's report shows all 6 tiles (SEA's has no "Total Factors
// SDR Tracker" tile at all) -- data.kpiKeys (from the API, per region) says
// which ones to show and in what order, matching each report exactly.
const SQL_KPI_LABELS = {
  recordCount: 'Total Records',
  opportunityCount: 'Total Opportunity Count',
  engagementScore: 'Total Factors Engagement Score',
  sdrTracker: 'Total Factors SDR Tracker',
  mrr: 'Total Product Amount (MRR)',
  arr: 'Total Product Amount (ARR)',
};

function renderSqlKpis(grandTotal, kpiKeys) {
  return kpiKeys.map(key => `
    <div class="kpi-tile">
      <div class="label">${SQL_KPI_LABELS[key]}</div>
      <div class="value">${SQL_METRIC_FMT[key](grandTotal[key])}</div>
    </div>
  `).join('');
}

function sqlMetricCells(metrics, bold) {
  return SQL_METRIC_COLUMNS_KEYS.map(key => `<td class="pivot-cell${bold ? ' pivot-cell-count' : ''}">${SQL_METRIC_FMT[key](metrics[key])}</td>`).join('');
}
const SQL_METRIC_COLUMNS_KEYS = ['engagementScore', 'mrr', 'opportunityCount', 'sdrTracker', 'arr', 'recordCount'];

function renderSqlHead(columns) {
  return `
    <tr>
      <th class="pin pin-quarter">SQL Change Date</th>
      <th class="pin pin-subsource">Opportunity Source</th>
      <th class="pin pin-metric">Opportunity Sub Source</th>
      ${columns.map(c => `<th>${escapeHtml(c.label)}</th>`).join('')}
    </tr>
  `;
}

function renderSqlBody(table) {
  if (!table.rows.length) return '<tr><td colspan="99" class="empty">No matching opportunities in this range.</td></tr>';

  return table.rows.map(row => {
    const quarterCell = row.quarterRowSpan
      ? `<td class="pin pin-quarter" rowspan="${row.quarterRowSpan}">${escapeHtml(row.quarter)}</td>`
      : '';
    const sourceCell = row.type === 'data'
      ? (row.sourceRowSpan ? `<td class="pin pin-subsource" rowspan="${row.sourceRowSpan}">${escapeHtml(row.source)}</td>` : '')
      : row.type === 'sourceSubtotal'
        ? ''
        : `<td class="pin pin-subsource"></td>`;
    const isSubtotal = row.type !== 'data';
    const subSourceLabel = row.type === 'quarterSubtotal' ? 'Subtotal' : row.subSource;
    const subSourceColspan = row.type === 'sourceSubtotal' ? ' colspan="1"' : '';
    return `
      <tr class="${isSubtotal ? 'pivot-total-row' : ''}">
        ${quarterCell}
        ${sourceCell}
        <td class="pin pin-metric${isSubtotal ? ' pivot-cell-count' : ''}"${subSourceColspan}>${escapeHtml(subSourceLabel)}</td>
        ${sqlMetricCells(row.metrics, isSubtotal)}
      </tr>
    `;
  }).join('');
}

function renderSqlFoot(table) {
  return `
    <tr class="pivot-total-row">
      <td class="pin pin-quarter">Total</td>
      <td class="pin pin-subsource"></td>
      <td class="pin pin-metric"></td>
      ${sqlMetricCells(table.grandTotal, true)}
    </tr>
  `;
}

function renderSqlRegion(data) {
  const template = document.getElementById('sql-region-template');
  const node = template.content.cloneNode(true);

  node.querySelector('.fixed-range-note').textContent = data.fixedDateRange
    ? `This report uses a fixed date range (${data.fixedDateRange[0]} to ${data.fixedDateRange[1]}) regardless of the filters above.`
    : '';
  node.querySelector('.sql-kpi-row').innerHTML = renderSqlKpis(data.table.grandTotal, data.kpiKeys);
  node.querySelector('.legend').innerHTML = renderLegend(data.subSourceOrder);
  node.querySelector('.funnel-chart').innerHTML = data.chart.length
    ? renderChart(data)
    : '<div class="empty">No matching opportunities in this range.</div>';

  node.querySelector('.sql-table thead').innerHTML = renderSqlHead(data.table.columns);
  node.querySelector('.sql-table tbody').innerHTML = renderSqlBody(data.table);
  node.querySelector('.sql-table tfoot').innerHTML = data.table.rows.length ? renderSqlFoot(data.table) : '';

  return node;
}

// Trends tab: Leads/IQL/MQL/SQL's graphical breakdowns only, no KPI tiles
// and no pivot table -- the Funnel View tab already shows that same
// underlying data as a table (Leads/IQL/MQL/SQL columns), so repeating it
// here would just be redundant. Each chart reuses renderChart()/
// renderLegend() exactly as the old per-stage tabs did. All four stages are
// 'breakdown' mode: Leads/IQL/MQL by Sub Lead Source, SQL by Opportunity
// Source > Opportunity Sub Source (IQL/MQL's own pivot table above still
// groups by Lead Source / Owner Team -- only this chart's data is overridden
// to Sub Lead Source, see computeSubSourceTrendChart in api/clg-regions.js).
const TRENDS_STAGES = [
  { key: 'lead', label: 'Leads' },
  { key: 'iql', label: 'IQL' },
  { key: 'mql', label: 'MQL' },
  { key: 'sql', label: 'SQL' },
];
function renderTrends(region) {
  const wrap = document.createElement('div');
  wrap.className = 'trends-wrap';

  for (const { key, label } of TRENDS_STAGES) {
    const data = lastData.regions[region][key];
    const section = document.createElement('section');
    section.className = 'channel';

    const chartInnerLabel = data.chartInnerLabel || (data.pivot && data.pivot.innerLabel);
    const title = data.chartMode === 'breakdown'
      ? `${escapeHtml(data.dateAxisLabel)} &gt; ${escapeHtml(chartInnerLabel)}`
      : escapeHtml(data.dateAxisLabel);

    const fixedRangeNote = data.fixedDateRange
      ? `<div class="fixed-range-note">This report uses a fixed date range (${data.fixedDateRange[0]} to ${data.fixedDateRange[1]}) regardless of the filters above.</div>`
      : '';

    section.innerHTML = `
      <h3 class="trends-stage-label">${label}</h3>
      ${fixedRangeNote}
      <div class="funnel-chart-wrap">
        <div class="funnel-chart-header">
          <h3 class="chart-title">${title}</h3>
          <div class="legend">${data.chartMode === 'breakdown' ? renderLegend(data.subSourceOrder) : ''}</div>
        </div>
        <div class="funnel-chart">${data.chart.length ? renderChart(data) : '<div class="empty">No matching records in this range.</div>'}</div>
      </div>
      ${key === 'sql' ? `
        <div class="funnel-chart-wrap">
          <div class="funnel-chart-header">
            <h3 class="chart-title">MRR Trend &gt; Opportunity Sub Source</h3>
            <div class="legend">${renderLegend(data.subSourceOrder)}</div>
          </div>
          <div class="funnel-chart">${data.mrrChart && data.mrrChart.length ? renderChart({ chart: data.mrrChart, subSourceOrder: data.subSourceOrder, chartMode: 'breakdown' }, fmtCurrency) : '<div class="empty">No matching opportunities in this range.</div>'}</div>
        </div>
      ` : ''}
    `;
    wrap.appendChild(section);
  }
  return wrap;
}

function render() {
  if (!lastData) return;
  const app = document.getElementById('app');
  app.innerHTML = '';
  // "All Regions" combines cleanly for the KPI tiles/charts up top (plain
  // sums), but each region's Salesforce report genuinely differs in shape
  // below that -- different pivot fields (Owner Team vs Lead Source), SEA/EU's
  // SQL using a fixed prior-FY window instead of the picker, etc (see
  // api/clg-regions.js). Rather than silently merge mismatched dimensions
  // into a misleading table, both detailed tabs ask the user to pick one
  // region instead.
  if (activeRegion === 'All') {
    app.innerHTML = '<div class="all-regions-notice">Select a specific region above to view its detailed breakdown.</div>';
    animateViewIn(app);
    return;
  }
  if (activeStage === 'trends') {
    app.appendChild(renderTrends(activeRegion));
    animateViewIn(app);
    return;
  }
  const data = lastData.regions[activeRegion][activeStage];
  const prevRegionData = leadsPrevData && leadsPrevData.regions[activeRegion];
  const prevPivot = prevRegionData && prevRegionData[activeStage] ? prevRegionData[activeStage].pivot : null;
  app.appendChild(renderRegion(activeRegion, activeStage, data, prevPivot));
  animateViewIn(app);
}

// Reads totalRecords/totalNDL off any /api/clg-regions-shaped payload (the
// live lastData or a comparison-range leadsPrevData) for the given regions --
// shared by renderOverview's current and comparison figures.
function sumLeadTotals(data, regionsToSum) {
  let totalRecords = 0, totalNDL = 0;
  if (!data) return { totalRecords, totalNDL };
  for (const region of regionsToSum) {
    const lead = data.regions[region] && data.regions[region].lead;
    if (!lead) continue;
    totalRecords += lead.totalRecords;
    totalNDL += lead.totalNDL;
  }
  return { totalRecords, totalNDL };
}

// ---- Overview boxes: Leads / Total NDL / Leads+NDL, for the active region or
// summed across all 4 when "All Regions" is selected -- always read off the
// Leads-stage totals regardless of which stage tab is currently open. Shows a
// delta badge against leadsPrevData (the currently active date-range
// comparison, if any -- see the "Compare" controls below). ----
function renderOverview() {
  if (!lastData) return;
  const regionsToSum = activeRegion === 'All' ? REGIONS.map(r => r.key) : [activeRegion];
  const { totalRecords, totalNDL } = sumLeadTotals(lastData, regionsToSum);
  const prev = leadsPrevData ? sumLeadTotals(leadsPrevData, regionsToSum) : null;

  animateNumberText(document.getElementById('overviewLeads'), totalRecords);
  animateNumberText(document.getElementById('overviewNdl'), totalNDL);
  animateNumberText(document.getElementById('overviewSum'), totalRecords + totalNDL);
  setKpiDelta('overviewLeadsDelta', totalRecords, prev ? prev.totalRecords : null);
  setKpiDelta('overviewNdlDelta', totalNDL, prev ? prev.totalNDL : null);
  setKpiDelta('overviewSumDelta', totalRecords + totalNDL, prev ? prev.totalRecords + prev.totalNDL : null);
}

// ---- Campaigns tile: a live LinkedIn/Meta spend summary for the same
// [currentStartDate, currentEndDate] window and active region (or all 4
// summed, for "All Regions") as the Leads/NDL tiles beside it -- fetched from
// /api/clg-spends alongside the Leads data in load() below, not a separate
// date range. ----
let overviewSpendsData = null;
function renderOverviewSpends() {
  const linkedinEl = document.getElementById('overviewSpendsLinkedin');
  const metaEl = document.getElementById('overviewSpendsMeta');
  const totalEl = document.getElementById('overviewSpendsTotal');
  if (!overviewSpendsData) {
    linkedinEl.textContent = metaEl.textContent = totalEl.textContent = '-';
    return;
  }
  const regionsToSum = activeRegion === 'All' ? REGIONS.map(r => r.key) : [activeRegion];
  let linkedinSpend = 0, metaSpend = 0;
  for (const region of regionsToSum) {
    const regionData = overviewSpendsData.regions[region];
    if (!regionData) continue;
    linkedinSpend += regionData.linkedin.kpi.spend;
    metaSpend += regionData.meta.kpi.spend;
  }
  animateNumberText(linkedinEl, linkedinSpend, fmtCurrency);
  animateNumberText(metaEl, metaSpend, fmtCurrency);
  animateNumberText(totalEl, linkedinSpend + metaSpend, fmtCurrency);
}

// ---- Region filter: a compact dropdown in the topbar (replaces the old
// donut+legend widget), built from REGIONS, plus "All Regions". ----
function populateRegionSelectLeads() {
  const sel = document.getElementById('regionSelectLeads');
  sel.innerHTML = ['All', ...REGIONS.map(r => r.key)]
    .map(key => `<option value="${key}">${key === 'All' ? 'All Regions' : escapeHtml(key)}</option>`).join('');
  sel.value = activeRegion;
}

// ---- Radar widget: purely illustrative "live tracker" -- blip count scales
// loosely with the active region's lead volume, positions are fixed (12
// deterministic polar slots) so the widget doesn't jitter on every reload. ----
const RADAR_CX = 100, RADAR_CY = 100;
// Still used by the Spends tab's Live Campaign Radar (spendsRenderRadar) --
// the Leads tab's own radar (which used to share these) was replaced by the
// TAL/Non-TAL widget below.
const RADAR_BLIP_SLOTS = [
  { deg: 18,  r: 38 }, { deg: 72,  r: 60 }, { deg: 128, r: 30 }, { deg: 165, r: 70 },
  { deg: 210, r: 48 }, { deg: 252, r: 74 }, { deg: 293, r: 36 }, { deg: 328, r: 56 },
  { deg: 350, r: 24 }, { deg: 95,  r: 45 }, { deg: 145, r: 62 }, { deg: 185, r: 28 },
];
function radarToXY(deg, r) {
  const rad = (deg - 90) * Math.PI / 180;
  return [RADAR_CX + r * Math.cos(rad), RADAR_CY + r * Math.sin(rad)];
}

// Reads TAL/Non-TAL lead counts (+ account count) off any /api/clg-regions-
// shaped payload for the given regions -- shared by renderTalWidget's current
// and comparison figures. Records are only collected for `data === lastData`
// callers (the comparison payload never needs a click-through list).
function sumTalLeadCounts(data, regionsToSum, { withRecords = false } = {}) {
  let talCount = 0, nonTalCount = 0, talRecords = [], nonTalRecords = [], accountCount = 0, accountRecords = [];
  if (data) {
    for (const region of regionsToSum) {
      const regionData = data.regions[region];
      if (!regionData) continue;
      accountCount += regionData.talAccountCount || 0;
      if (withRecords) accountRecords = accountRecords.concat(regionData.talAccountRecords || []);
      const tal = regionData.lead && regionData.lead.tal;
      if (!tal) continue;
      talCount += tal.talCount;
      nonTalCount += tal.nonTalCount;
      if (withRecords) {
        talRecords = talRecords.concat(tal.talRecords);
        nonTalRecords = nonTalRecords.concat(tal.nonTalRecords);
      }
    }
  }
  return { talCount, nonTalCount, talRecords, nonTalRecords, accountCount, accountRecords };
}

// TAL/Non-TAL widget -- replaces the old Live Lead Radar. Each company's
// verdict is decided once (server-side, from that company's first-ever lead
// touch) and never re-evaluated per lead -- see api/clg-regions.js's
// buildTalVerdictMap. What DOES follow the dashboard's selected date range
// and region here is simply which leads get counted/listed under each
// verdict, exactly like every other Leads-tab number. Shows a delta badge
// against leadsPrevData when a date-range comparison is active.
function renderTalWidget() {
  const regionsToSum = activeRegion === 'All' ? REGIONS.map(r => r.key) : [activeRegion];
  const { talCount, nonTalCount, talRecords, nonTalRecords, accountCount, accountRecords } = sumTalLeadCounts(lastData, regionsToSum, { withRecords: true });
  const prev = leadsPrevData ? sumTalLeadCounts(leadsPrevData, regionsToSum) : null;
  const total = talCount + nonTalCount;
  const talPct = total > 0 ? (talCount / total) * 100 : 0;

  document.getElementById('talWindow').textContent = `Scan window: ${currentStartDate} → ${currentEndDate}`;

  const accountsCell = document.getElementById('talFunnelAccountsTal');
  animateNumberText(accountsCell.querySelector('.tal-funnel-val-num') || accountsCell, accountCount);
  accountsCell.dataset.records = encodeURIComponent(JSON.stringify(accountRecords));
  accountsCell.dataset.statusLabel = 'TAL Accounts';
  accountsCell.dataset.recordKind = 'account';
  // Total Accounts has no Non-TAL concept (see the funnel table's comment), so
  // its bar is always a full TAL bar rather than a real proportion.
  setTalRowBar('talFunnelAccountsBarTal', 1, 0);

  renderTalFunnelCell('talFunnelLeadsTal', talCount, talRecords, 'TAL Leads', prev ? prev.talCount : null);
  renderTalFunnelCell('talFunnelLeadsNonTal', nonTalCount, nonTalRecords, 'Non-TAL Leads', prev ? prev.nonTalCount : null);
  setTalRowBar('talFunnelLeadsBarTal', talCount, nonTalCount);

  renderTalFunnelTable(regionsToSum);
}

// Width of a stage row's TAL/Non-TAL split bar -- a bare percentage-of-total,
// same math as the widget's own talPct above, just per-row instead of once
// for the whole widget. Falls back to a half-filled bar when both sides are
// 0 (nothing to show a real proportion for yet).
function setTalRowBar(elId, tal, nonTal) {
  const el = document.getElementById(elId);
  if (!el) return;
  const total = tal + nonTal;
  el.style.width = `${total > 0 ? (tal / total) * 100 : 50}%`;
}

// IQL/MQL/SQL/MRR TAL/Non-TAL -- same verdict, same per-stage .tal object
// shape as Leads (see computeTalBreakdown/computeSqlTalBreakdown in
// api/clg-regions.js), just summed from a different stage each row. MRR
// reuses SQL's own .tal object (talMrr/nonTalMrr are dollar sums over the
// exact same deduped-by-Opportunity rows SQL's opportunity count comes from)
// rather than being a separate stage.
function sumTalFunnelStages(data, regionsToSum, { withRecords = false } = {}) {
  const sums = {
    iql: { tal: 0, nonTal: 0, talRecords: [], nonTalRecords: [] },
    mql: { tal: 0, nonTal: 0, talRecords: [], nonTalRecords: [] },
    sql: { tal: 0, nonTal: 0, talRecords: [], nonTalRecords: [] },
    mrr: { tal: 0, nonTal: 0, talRecords: [], nonTalRecords: [] },
  };
  if (!data) return sums;
  for (const region of regionsToSum) {
    const regionData = data.regions[region];
    if (!regionData) continue;
    for (const stage of ['iql', 'mql', 'sql']) {
      const tal = regionData[stage] && regionData[stage].tal;
      if (!tal) continue;
      sums[stage].tal += tal.talCount;
      sums[stage].nonTal += tal.nonTalCount;
      if (withRecords) {
        sums[stage].talRecords = sums[stage].talRecords.concat(tal.talRecords);
        sums[stage].nonTalRecords = sums[stage].nonTalRecords.concat(tal.nonTalRecords);
      }
    }
    const sqlTal = regionData.sql && regionData.sql.tal;
    if (sqlTal && sqlTal.talMrr !== undefined) {
      sums.mrr.tal += sqlTal.talMrr;
      sums.mrr.nonTal += sqlTal.nonTalMrr;
      if (withRecords) {
        sums.mrr.talRecords = sums.mrr.talRecords.concat(sqlTal.talRecords);
        sums.mrr.nonTalRecords = sums.mrr.nonTalRecords.concat(sqlTal.nonTalRecords);
      }
    }
  }
  return sums;
}

function renderTalFunnelCell(elId, count, records, label, prevCount, formatFn = fmtInt) {
  const el = document.getElementById(elId);
  if (!el) return;
  animateNumberText(el.querySelector('.tal-funnel-val-num') || el, count, formatFn);
  el.dataset.records = encodeURIComponent(JSON.stringify(records));
  el.dataset.statusLabel = label;
  setKpiDelta(`${elId}Delta`, count, prevCount);
}

function renderTalFunnelTable(regionsToSum) {
  const sums = sumTalFunnelStages(lastData, regionsToSum, { withRecords: true });
  const prevSums = leadsPrevData ? sumTalFunnelStages(leadsPrevData, regionsToSum) : null;
  const prev = (stage, side) => prevSums ? prevSums[stage][side] : null;

  renderTalFunnelCell('talFunnelIqlTal', sums.iql.tal, sums.iql.talRecords, 'TAL IQL', prev('iql', 'tal'));
  renderTalFunnelCell('talFunnelIqlNonTal', sums.iql.nonTal, sums.iql.nonTalRecords, 'Non-TAL IQL', prev('iql', 'nonTal'));
  setTalRowBar('talFunnelIqlBarTal', sums.iql.tal, sums.iql.nonTal);
  renderTalFunnelCell('talFunnelMqlTal', sums.mql.tal, sums.mql.talRecords, 'TAL MQL', prev('mql', 'tal'));
  renderTalFunnelCell('talFunnelMqlNonTal', sums.mql.nonTal, sums.mql.nonTalRecords, 'Non-TAL MQL', prev('mql', 'nonTal'));
  setTalRowBar('talFunnelMqlBarTal', sums.mql.tal, sums.mql.nonTal);
  renderTalFunnelCell('talFunnelSqlTal', sums.sql.tal, sums.sql.talRecords, 'TAL SQL', prev('sql', 'tal'));
  renderTalFunnelCell('talFunnelSqlNonTal', sums.sql.nonTal, sums.sql.nonTalRecords, 'Non-TAL SQL', prev('sql', 'nonTal'));
  setTalRowBar('talFunnelSqlBarTal', sums.sql.tal, sums.sql.nonTal);
  renderTalFunnelCell('talFunnelMrrTal', sums.mrr.tal, sums.mrr.talRecords, 'TAL MRR', prev('mrr', 'tal'), fmtCurrency);
  renderTalFunnelCell('talFunnelMrrNonTal', sums.mrr.nonTal, sums.mrr.nonTalRecords, 'Non-TAL MRR', prev('mrr', 'nonTal'), fmtCurrency);
}

// ---- Date-range control: an always-visible calendar card (not a dropdown),
// styled after the reference MonthCalendar component. Selecting is always a
// two-click gesture -- first click picks a start day (shown as a pending
// pill), second click picks an end day (which can be the same day again, for
// a single-day filter). That pair is held as a DRAFT (draftStartDate/
// draftEndDate), not applied immediately -- the popover stays open, showing
// Update/Cancel buttons, and only Update commits the draft into
// currentStartDate/currentEndDate (reloading the dashboard) and closes the
// popover; Cancel (or reopening the popover later) discards the draft and
// reverts to whatever range is currently applied. Quick-range presets and
// Reset are one-click, unambiguous actions, so they still apply immediately.
// hasExplicitSelection tracks whether the user has actually picked a day (vs.
// still sitting on the FY-to-date default), so the default's wide span
// doesn't paint every visible day as "in range". Future dates are disabled --
// this dashboard only ever has data up to today. ----
const DATE_LABEL_FMT = new Intl.DateTimeFormat('en-US', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const RANGE_DATE_FMT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const CALENDAR_MONTH_FMT = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

// First-of-month Date (UTC) for dateStr's month, shifted by offsetMonths --
// used to seed each side of the two-month calendar view.
function monthStartUTC(dateStr, offsetMonths) {
  const d = new Date(dateStr + 'T00:00:00Z');
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offsetMonths, 1));
}
// Quarter start (Jan/Apr/Jul/Oct 1) for "today" -- these are the same month
// boundaries whether you call them calendar quarters or fiscal quarters
// (FY runs Apr-Mar, see fiscalYearStartDate), so one function covers QTD.
function quarterStartDate() {
  const now = new Date();
  const qStartMonth = Math.floor(now.getUTCMonth() / 3) * 3;
  return `${now.getUTCFullYear()}-${String(qStartMonth + 1).padStart(2, '0')}-01`;
}

let pendingRangeStart = null;
let draftStartDate = null;
let draftEndDate = null;
let hasExplicitSelection = false;
// Two months shown side-by-side (LinkedIn-style single-view range picker),
// each paged independently via its own prev/next -- defaults to the month
// before the selected end date (left) and the end date's own month (right).
let calendarViewDateLeft = monthStartUTC(currentEndDate, -1);
let calendarViewDateRight = monthStartUTC(currentEndDate, 0);

function renderCalendarHeader() {
  document.getElementById('dateRangeTriggerLabelLeads').textContent = formatDateRangeLabel(currentStartDate, currentEndDate);

  const hasDraft = draftStartDate && draftEndDate;
  const hasRange = hasExplicitSelection && currentStartDate !== currentEndDate;

  const rangePill = document.getElementById('calendarRangePill');
  if (hasDraft) {
    rangePill.textContent = draftStartDate === draftEndDate
      ? DATE_LABEL_FMT.format(new Date(draftEndDate + 'T00:00:00Z'))
      : `${RANGE_DATE_FMT.format(new Date(draftStartDate + 'T00:00:00Z'))} – ${RANGE_DATE_FMT.format(new Date(draftEndDate + 'T00:00:00Z'))}`;
    rangePill.classList.remove('hidden');
  } else if (pendingRangeStart) {
    rangePill.textContent = `From ${RANGE_DATE_FMT.format(new Date(pendingRangeStart + 'T00:00:00Z'))} — pick end date`;
    rangePill.classList.remove('hidden');
  } else if (hasRange) {
    rangePill.textContent = `${RANGE_DATE_FMT.format(new Date(currentStartDate + 'T00:00:00Z'))} – ${RANGE_DATE_FMT.format(new Date(currentEndDate + 'T00:00:00Z'))}`;
    rangePill.classList.remove('hidden');
  } else if (hasExplicitSelection) {
    rangePill.textContent = DATE_LABEL_FMT.format(new Date(currentEndDate + 'T00:00:00Z'));
    rangePill.classList.remove('hidden');
  } else {
    rangePill.classList.add('hidden');
  }

  document.getElementById('calendarResetBtn').classList.toggle('hidden', !(pendingRangeStart || hasExplicitSelection));
  document.getElementById('calendarHelperText').classList.toggle('hidden', !!pendingRangeStart || !!hasDraft);
  document.getElementById('calendarApplyRow').classList.toggle('hidden', !hasDraft);
}

function renderCalendarMonthGrid(viewDate, gridId) {
  const year = viewDate.getUTCFullYear();
  const month = viewDate.getUTCMonth();
  const firstOfMonth = new Date(Date.UTC(year, month, 1));
  // Grid starts on Monday -- getUTCDay() is 0=Sun..6=Sat, shift so Mon=0.
  const leadingBlanks = (firstOfMonth.getUTCDay() + 6) % 7;
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

  const todayStr = new Date().toISOString().slice(0, 10);
  // While a draft exists, the calendar highlights the DRAFT pair instead of
  // whatever's actually applied -- the applied range only reappears if the
  // draft is cancelled/discarded.
  const hasDraft = draftStartDate && draftEndDate;
  const displayStart = hasDraft ? draftStartDate : currentStartDate;
  const displayEnd = hasDraft ? draftEndDate : currentEndDate;
  const hasSelection = hasDraft || hasExplicitSelection;
  const hasRange = hasSelection && displayStart !== displayEnd;
  const cells = [];
  for (let i = 0; i < leadingBlanks; i++) cells.push('<span class="calendar-day calendar-day-blank"></span>');
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const isFuture = dateStr > todayStr;
    const isToday = dateStr === todayStr;
    const isPending = pendingRangeStart === dateStr;
    // isEdge covers both a completed range's two endpoints AND a single-day
    // selection (start === end lands on the same cell) -- no longer a
    // separate "single" case since every selection goes through the same
    // pending-start-then-end flow.
    const isEdge = hasSelection && !pendingRangeStart && (dateStr === displayStart || dateStr === displayEnd);
    const isBetween = hasRange && !pendingRangeStart && dateStr > displayStart && dateStr < displayEnd;

    const classes = ['calendar-day'];
    if (isFuture) classes.push('calendar-day-future');
    else if (isPending) classes.push('calendar-day-pending');
    else if (isEdge) classes.push('calendar-day-selected');
    else if (isBetween) classes.push('calendar-day-in-range');
    else if (isToday) classes.push('calendar-day-today');

    const attrs = isFuture ? 'disabled' : `data-date="${dateStr}"`;
    const dot = isToday && !isPending && !isEdge ? '<span class="calendar-day-dot"></span>' : '';
    cells.push(`<button type="button" class="${classes.join(' ')}" ${attrs}>${day}${dot}</button>`);
  }
  document.getElementById(gridId).innerHTML = cells.join('');
}

function renderCalendar() {
  renderCalendarHeader();
  updateQuickRangeActive();
  document.getElementById('calendarMonthLabelLeft').textContent = CALENDAR_MONTH_FMT.format(calendarViewDateLeft).toUpperCase();
  document.getElementById('calendarMonthLabelRight').textContent = CALENDAR_MONTH_FMT.format(calendarViewDateRight).toUpperCase();
  renderCalendarMonthGrid(calendarViewDateLeft, 'calendarGridLeft');
  renderCalendarMonthGrid(calendarViewDateRight, 'calendarGridRight');
}

// Picking a start+end day only stages a DRAFT -- it neither reloads the
// dashboard nor closes the popover. Only commitDateRange() (the Update
// button) does that; see the top-of-section comment for why.
function handleDayClick(dateStr) {
  if (!pendingRangeStart) {
    pendingRangeStart = dateStr;
    renderCalendar();
    return;
  }
  draftStartDate = pendingRangeStart < dateStr ? pendingRangeStart : dateStr;
  draftEndDate = pendingRangeStart < dateStr ? dateStr : pendingRangeStart;
  pendingRangeStart = null;
  renderCalendar();
  pulseScale(document.querySelector('#calendarTwoMonths .calendar-day-selected'));
}

function commitDateRange() {
  if (draftStartDate && draftEndDate) {
    currentStartDate = draftStartDate;
    currentEndDate = draftEndDate;
    hasExplicitSelection = true;
  }
  draftStartDate = null;
  draftEndDate = null;
  renderCalendar();
  load();
  closeAllDatePopovers();
}

function cancelDraftRange() {
  pendingRangeStart = null;
  draftStartDate = null;
  draftEndDate = null;
  renderCalendar();
  closeAllDatePopovers();
}

function resetDateRange() {
  pendingRangeStart = null;
  draftStartDate = null;
  draftEndDate = null;
  hasExplicitSelection = false;
  currentStartDate = DEFAULT_START_DATE;
  currentEndDate = DEFAULT_END_DATE;
  calendarViewDateLeft = monthStartUTC(currentEndDate, -1);
  calendarViewDateRight = monthStartUTC(currentEndDate, 0);
  renderCalendar();
  load();
  closeAllDatePopovers();
}

// ---- Quick-range presets (7/14/30 days, quarter-to-date, current FY --
// all ending today) -- same idea as the Spends tab's, mirrored here for the
// Leads dashboard's own calendar. One-click, unambiguous actions -- these
// still apply and close immediately, unlike a manual two-click day selection. ----
function updateQuickRangeActive() {
  const todayStr = new Date().toISOString().slice(0, 10);
  document.querySelectorAll('#quickRangeRow .quick-range-btn').forEach(btn => {
    const expectedStart = btn.dataset.preset
      ? (btn.dataset.preset === 'fy' ? fiscalYearStartDate() : quarterStartDate())
      : addDaysToDateStr(todayStr, -(parseInt(btn.dataset.days, 10) - 1));
    const isActive = hasExplicitSelection && currentEndDate === todayStr && currentStartDate === expectedStart;
    btn.classList.toggle('active', isActive);
  });
}

function applyQuickRange(days) {
  const todayStr = new Date().toISOString().slice(0, 10);
  pendingRangeStart = null;
  draftStartDate = null;
  draftEndDate = null;
  currentEndDate = todayStr;
  currentStartDate = addDaysToDateStr(todayStr, -(days - 1));
  hasExplicitSelection = true;
  calendarViewDateLeft = monthStartUTC(currentEndDate, -1);
  calendarViewDateRight = monthStartUTC(currentEndDate, 0);
  renderCalendar();
  load();
  closeAllDatePopovers();
}

function applyDatePreset(preset) {
  const todayStr = new Date().toISOString().slice(0, 10);
  pendingRangeStart = null;
  draftStartDate = null;
  draftEndDate = null;
  currentEndDate = todayStr;
  currentStartDate = preset === 'fy' ? fiscalYearStartDate() : quarterStartDate();
  hasExplicitSelection = true;
  calendarViewDateLeft = monthStartUTC(currentEndDate, -1);
  calendarViewDateRight = monthStartUTC(currentEndDate, 0);
  renderCalendar();
  load();
  closeAllDatePopovers();
}

// ---- Leads tab date-range comparison -- mirrors the Spends tab's "Compare"
// controls exactly (same 'auto' previous-N-days / 'custom' hand-picked-range
// modes, same two-click calendar), but against /api/clg-regions instead of
// /api/clg-spends, and independent state -- comparing the Leads tab's range
// has nothing to do with whatever comparison (if any) is active on Spends.
// leadsPrevData feeds the delta badges on the overview tiles and the
// TAL/Non-TAL widget's Lead/IQL/MQL/SQL/MRR figures. ----
let leadsComparePeriod = null;
let leadsCompareMode = null; // null | 'auto' | 'custom'
let leadsPrevData = null;
let leadsCustomCompareStart = null;
let leadsCustomCompareEnd = null;

function leadsUpdateCompareToggle() {
  leadsComparePeriod = detectComparePeriod(currentStartDate, currentEndDate);
  const btn = document.getElementById('leadsCompareToggle');
  const closeBtn = document.getElementById('leadsCompareClose');
  const customBtn = document.getElementById('leadsCompareCustomBtn');

  if (!leadsComparePeriod) {
    btn.classList.add('hidden');
    if (leadsCompareMode === 'auto') { leadsCompareMode = null; leadsPrevData = null; }
  } else {
    btn.textContent = `Compare with previous ${leadsComparePeriod.label}`;
    btn.classList.remove('hidden');
    btn.classList.toggle('active', leadsCompareMode === 'auto');
  }

  customBtn.classList.toggle('active', leadsCompareMode === 'custom');
  document.getElementById('leadsCompareCustomLabel').textContent = leadsCompareMode === 'custom'
    ? `Comparing vs ${RANGE_DATE_FMT.format(new Date(leadsCustomCompareStart + 'T00:00:00Z'))} – ${RANGE_DATE_FMT.format(new Date(leadsCustomCompareEnd + 'T00:00:00Z'))}`
    : 'Compare with custom range';

  closeBtn.classList.toggle('hidden', !leadsCompareMode);
}

// Only 'auto' mode needs a refetch when the primary range changes -- 'custom'
// mode's comparison range is fixed by the user, independent of the primary
// range. Called from load() so every primary-range change keeps it in sync.
async function leadsFetchPrevIfNeeded() {
  if (leadsCompareMode !== 'auto' || !leadsComparePeriod) return;
  const prevEnd = addDaysToDateStr(currentStartDate, -1);
  const prevStart = addDaysToDateStr(prevEnd, -(leadsComparePeriod.days - 1));
  try {
    const res = await fetch(`/api/clg-regions?startDate=${prevStart}&endDate=${prevEnd}`);
    const data = await res.json();
    leadsPrevData = res.ok ? data : null;
  } catch (err) {
    leadsPrevData = null;
  }
}

function leadsDisableCompare() {
  leadsCompareMode = null;
  leadsPrevData = null;
  leadsCustomCompareStart = null;
  leadsCustomCompareEnd = null;
  document.getElementById('leadsCompareToggle').classList.remove('active');
  document.getElementById('leadsCompareCustomBtn').classList.remove('active');
  document.getElementById('leadsCompareCustomLabel').textContent = 'Compare with custom range';
  document.getElementById('leadsCompareClose').classList.add('hidden');
  renderOverview();
  renderTalWidget();
  // Without this, the Funnel View pivot table (render() is what rebuilds it)
  // kept showing its last-drawn delta badges after Compare was turned off --
  // stale comparison numbers left on screen looking like a still-active
  // comparison, not just a missed refresh.
  render();
}

document.getElementById('leadsCompareToggle').addEventListener('click', async (e) => {
  if (leadsCompareMode === 'auto') {
    leadsDisableCompare();
    return;
  }
  leadsCompareMode = 'auto';
  document.getElementById('leadsCompareToggle').classList.add('active');
  document.getElementById('leadsCompareCustomBtn').classList.remove('active');
  document.getElementById('leadsCompareCustomLabel').textContent = 'Compare with custom range';
  document.getElementById('leadsCompareClose').classList.remove('hidden');
  renderLeadsCompareCalendar();
  pulseScale(e.currentTarget);
  const status = document.getElementById('status');
  status.textContent = 'Loading comparison...';
  await leadsFetchPrevIfNeeded();
  status.textContent = '';
  renderOverview();
  renderTalWidget();
  render();
});

document.getElementById('leadsCompareClose').addEventListener('click', (e) => {
  e.stopPropagation();
  leadsDisableCompare();
});

// Custom comparison range -- same two-month single-view calendar and
// mandatory two-click (start, then end) selection as the primary date
// pickers, letting the user compare the selected primary range against ANY
// hand-picked window.
let leadsComparePendingRangeStart = null;
let leadsCompareDraftStartDate = null;
let leadsCompareDraftEndDate = null;
let leadsCompareCalendarViewDateLeft = monthStartUTC(currentEndDate, -1);
let leadsCompareCalendarViewDateRight = monthStartUTC(currentEndDate, 0);

function renderLeadsCompareCalendarHeader() {
  const hasDraft = leadsCompareDraftStartDate && leadsCompareDraftEndDate;
  const hasSelection = leadsCompareMode === 'custom' && leadsCustomCompareStart && leadsCustomCompareEnd;
  const rangePill = document.getElementById('compareCalendarRangePillLeads');
  if (hasDraft) {
    rangePill.textContent = leadsCompareDraftStartDate === leadsCompareDraftEndDate
      ? DATE_LABEL_FMT.format(new Date(leadsCompareDraftEndDate + 'T00:00:00Z'))
      : `${RANGE_DATE_FMT.format(new Date(leadsCompareDraftStartDate + 'T00:00:00Z'))} – ${RANGE_DATE_FMT.format(new Date(leadsCompareDraftEndDate + 'T00:00:00Z'))}`;
    rangePill.classList.remove('hidden');
  } else if (leadsComparePendingRangeStart) {
    rangePill.textContent = `From ${RANGE_DATE_FMT.format(new Date(leadsComparePendingRangeStart + 'T00:00:00Z'))} — pick end date`;
    rangePill.classList.remove('hidden');
  } else if (hasSelection) {
    rangePill.textContent = leadsCustomCompareStart === leadsCustomCompareEnd
      ? DATE_LABEL_FMT.format(new Date(leadsCustomCompareEnd + 'T00:00:00Z'))
      : `${RANGE_DATE_FMT.format(new Date(leadsCustomCompareStart + 'T00:00:00Z'))} – ${RANGE_DATE_FMT.format(new Date(leadsCustomCompareEnd + 'T00:00:00Z'))}`;
    rangePill.classList.remove('hidden');
  } else {
    rangePill.classList.add('hidden');
  }
  document.getElementById('compareCalendarResetBtnLeads').classList.toggle('hidden', !(leadsComparePendingRangeStart || hasSelection));
  document.getElementById('compareCalendarHelperTextLeads').classList.toggle('hidden', !!leadsComparePendingRangeStart || !!hasDraft);
  document.getElementById('compareCalendarApplyRowLeads').classList.toggle('hidden', !hasDraft);
}

function leadsCompareUpdateQuickRangeActive() {
  const todayStr = new Date().toISOString().slice(0, 10);
  document.querySelectorAll('#compareQuickRangeRowLeads .quick-range-btn').forEach(btn => {
    const expectedStart = btn.dataset.preset
      ? (btn.dataset.preset === 'fy' ? fiscalYearStartDate() : quarterStartDate())
      : addDaysToDateStr(todayStr, -(parseInt(btn.dataset.days, 10) - 1));
    const isActive = leadsCompareMode === 'custom' && leadsCustomCompareEnd === todayStr && leadsCustomCompareStart === expectedStart;
    btn.classList.toggle('active', isActive);
  });
}

function renderLeadsCompareCalendarMonthGrid(viewDate, gridId) {
  const year = viewDate.getUTCFullYear();
  const month = viewDate.getUTCMonth();
  const firstOfMonth = new Date(Date.UTC(year, month, 1));
  const leadingBlanks = (firstOfMonth.getUTCDay() + 6) % 7;
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const todayStr = new Date().toISOString().slice(0, 10);
  const hasDraft = leadsCompareDraftStartDate && leadsCompareDraftEndDate;
  const hasAppliedSelection = leadsCompareMode === 'custom' && leadsCustomCompareStart && leadsCustomCompareEnd;
  const displayStart = hasDraft ? leadsCompareDraftStartDate : leadsCustomCompareStart;
  const displayEnd = hasDraft ? leadsCompareDraftEndDate : leadsCustomCompareEnd;
  const hasSelection = hasDraft || hasAppliedSelection;
  const cells = [];
  for (let i = 0; i < leadingBlanks; i++) cells.push('<span class="calendar-day calendar-day-blank"></span>');
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const isFuture = dateStr > todayStr;
    const isToday = dateStr === todayStr;
    const isPending = leadsComparePendingRangeStart === dateStr;
    const isEdge = hasSelection && !leadsComparePendingRangeStart && (dateStr === displayStart || dateStr === displayEnd);
    const isBetween = hasSelection && !leadsComparePendingRangeStart && dateStr > displayStart && dateStr < displayEnd;
    const classes = ['calendar-day'];
    if (isFuture) classes.push('calendar-day-future');
    else if (isPending) classes.push('calendar-day-pending');
    else if (isEdge) classes.push('calendar-day-selected');
    else if (isBetween) classes.push('calendar-day-in-range');
    else if (isToday) classes.push('calendar-day-today');
    const attrs = isFuture ? 'disabled' : `data-date="${dateStr}"`;
    const dot = isToday && !isPending && !isEdge ? '<span class="calendar-day-dot"></span>' : '';
    cells.push(`<button type="button" class="${classes.join(' ')}" ${attrs}>${day}${dot}</button>`);
  }
  document.getElementById(gridId).innerHTML = cells.join('');
}

function renderLeadsCompareCalendar() {
  renderLeadsCompareCalendarHeader();
  leadsCompareUpdateQuickRangeActive();
  document.getElementById('compareCalendarMonthLabelLeftLeads').textContent = CALENDAR_MONTH_FMT.format(leadsCompareCalendarViewDateLeft).toUpperCase();
  document.getElementById('compareCalendarMonthLabelRightLeads').textContent = CALENDAR_MONTH_FMT.format(leadsCompareCalendarViewDateRight).toUpperCase();
  renderLeadsCompareCalendarMonthGrid(leadsCompareCalendarViewDateLeft, 'compareCalendarGridLeftLeads');
  renderLeadsCompareCalendarMonthGrid(leadsCompareCalendarViewDateRight, 'compareCalendarGridRightLeads');
}

async function applyLeadsCustomCompareRange(start, end) {
  leadsCustomCompareStart = start;
  leadsCustomCompareEnd = end;
  leadsCompareMode = 'custom';
  leadsCompareCalendarViewDateLeft = monthStartUTC(end, -1);
  leadsCompareCalendarViewDateRight = monthStartUTC(end, 0);
  renderLeadsCompareCalendar();
  document.getElementById('leadsCompareToggle').classList.remove('active');

  const status = document.getElementById('status');
  status.textContent = 'Loading comparison...';
  try {
    const res = await fetch(`/api/clg-regions?startDate=${start}&endDate=${end}`);
    const data = await res.json();
    leadsPrevData = res.ok ? data : null;
  } catch (err) {
    leadsPrevData = null;
  }
  status.textContent = '';
  leadsUpdateCompareToggle();
  document.getElementById('leadsCompareClose').classList.remove('hidden');
  renderOverview();
  renderTalWidget();
  render();
  closeAllDatePopovers();
}

function handleLeadsCompareDayClick(dateStr) {
  if (!leadsComparePendingRangeStart) {
    leadsComparePendingRangeStart = dateStr;
    renderLeadsCompareCalendar();
    return;
  }
  leadsCompareDraftStartDate = leadsComparePendingRangeStart < dateStr ? leadsComparePendingRangeStart : dateStr;
  leadsCompareDraftEndDate = leadsComparePendingRangeStart < dateStr ? dateStr : leadsComparePendingRangeStart;
  leadsComparePendingRangeStart = null;
  renderLeadsCompareCalendar();
  pulseScale(document.querySelector('#compareCalendarTwoMonthsLeads .calendar-day-selected'));
}

function leadsCompareCommitRange() {
  if (leadsCompareDraftStartDate && leadsCompareDraftEndDate) {
    applyLeadsCustomCompareRange(leadsCompareDraftStartDate, leadsCompareDraftEndDate);
  }
  leadsCompareDraftStartDate = null;
  leadsCompareDraftEndDate = null;
}

function leadsCompareCancelDraftRange() {
  leadsComparePendingRangeStart = null;
  leadsCompareDraftStartDate = null;
  leadsCompareDraftEndDate = null;
  renderLeadsCompareCalendar();
  closeAllDatePopovers();
}

function leadsCompareApplyQuickRange(days) {
  const todayStr = new Date().toISOString().slice(0, 10);
  leadsComparePendingRangeStart = null;
  leadsCompareDraftStartDate = null;
  leadsCompareDraftEndDate = null;
  applyLeadsCustomCompareRange(addDaysToDateStr(todayStr, -(days - 1)), todayStr);
}

function leadsCompareApplyDatePreset(preset) {
  const todayStr = new Date().toISOString().slice(0, 10);
  leadsComparePendingRangeStart = null;
  leadsCompareDraftStartDate = null;
  leadsCompareDraftEndDate = null;
  applyLeadsCustomCompareRange(preset === 'fy' ? fiscalYearStartDate() : quarterStartDate(), todayStr);
}

function leadsCompareResetRange() {
  leadsComparePendingRangeStart = null;
  leadsCompareDraftStartDate = null;
  leadsCompareDraftEndDate = null;
  if (leadsCompareMode === 'custom') { leadsDisableCompare(); return; }
  renderLeadsCompareCalendar();
}

document.getElementById('leadsCompareCustomBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const pop = document.getElementById('compareCustomPopoverLeads');
  const wasHidden = pop.classList.contains('hidden');
  closeAllDatePopovers();
  if (wasHidden) {
    leadsComparePendingRangeStart = null;
    leadsCompareDraftStartDate = null;
    leadsCompareDraftEndDate = null;
    if (!(leadsCompareMode === 'custom' && leadsCustomCompareEnd)) {
      leadsCompareCalendarViewDateLeft = monthStartUTC(currentEndDate, -1);
      leadsCompareCalendarViewDateRight = monthStartUTC(currentEndDate, 0);
    }
    renderLeadsCompareCalendar();
    pop.classList.remove('hidden');
  }
});
document.getElementById('compareCalendarApplyBtnLeads').addEventListener('click', leadsCompareCommitRange);
document.getElementById('compareCalendarCancelBtnLeads').addEventListener('click', leadsCompareCancelDraftRange);
document.getElementById('compareCalendarResetBtnLeads').addEventListener('click', leadsCompareResetRange);
document.getElementById('compareCalendarPrevBtnLeftLeads').addEventListener('click', () => {
  leadsCompareCalendarViewDateLeft = new Date(Date.UTC(leadsCompareCalendarViewDateLeft.getUTCFullYear(), leadsCompareCalendarViewDateLeft.getUTCMonth() - 1, 1));
  renderLeadsCompareCalendar();
});
document.getElementById('compareCalendarNextBtnLeftLeads').addEventListener('click', () => {
  leadsCompareCalendarViewDateLeft = new Date(Date.UTC(leadsCompareCalendarViewDateLeft.getUTCFullYear(), leadsCompareCalendarViewDateLeft.getUTCMonth() + 1, 1));
  renderLeadsCompareCalendar();
});
document.getElementById('compareCalendarPrevBtnRightLeads').addEventListener('click', () => {
  leadsCompareCalendarViewDateRight = new Date(Date.UTC(leadsCompareCalendarViewDateRight.getUTCFullYear(), leadsCompareCalendarViewDateRight.getUTCMonth() - 1, 1));
  renderLeadsCompareCalendar();
});
document.getElementById('compareCalendarNextBtnRightLeads').addEventListener('click', () => {
  leadsCompareCalendarViewDateRight = new Date(Date.UTC(leadsCompareCalendarViewDateRight.getUTCFullYear(), leadsCompareCalendarViewDateRight.getUTCMonth() + 1, 1));
  renderLeadsCompareCalendar();
});
document.getElementById('compareCalendarTwoMonthsLeads').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-date]');
  if (!btn) return;
  e.stopPropagation();
  handleLeadsCompareDayClick(btn.dataset.date);
});
document.getElementById('compareQuickRangeRowLeads').addEventListener('click', (e) => {
  const btn = e.target.closest('.quick-range-btn');
  if (!btn) return;
  pulseScale(btn);
  if (btn.dataset.preset) leadsCompareApplyDatePreset(btn.dataset.preset);
  else leadsCompareApplyQuickRange(parseInt(btn.dataset.days, 10));
});

function showSpends(show) {
  viewingSpends = show;
  const spendsEl = document.getElementById('spendsView');
  const leadsEl = document.getElementById('leadsView');
  spendsEl.classList.toggle('hidden', !show);
  leadsEl.classList.toggle('hidden', show);
  document.getElementById('spendsControls').classList.toggle('hidden', !show);
  document.getElementById('leadsControls').classList.toggle('hidden', show);
  closeAllDatePopovers();
  animateViewIn(show ? spendsEl : leadsEl, 18);
  smoothScrollTop();
  if (show) {
    spendsRenderCalendar();
    spendsLoad();
  }
}

// Toggles the topbar "Refreshing..." pill and dims the live metric areas
// (rather than leaving the previous range's numbers sitting on screen looking
// current) while a date-range/region refetch is in flight. Shared by the
// Leads and Spends views since the topbar-title lives above both.
function setRefreshing(isRefreshing, extraEls = []) {
  document.getElementById('loadingIndicator').classList.toggle('hidden', !isRefreshing);
  for (const el of extraEls) {
    if (el) el.classList.toggle('is-refreshing', isRefreshing);
  }
}

async function load() {
  const status = document.getElementById('status');
  const refreshTargets = [
    document.getElementById('overviewBoxes'),
    document.querySelector('.tal-widget'),
    document.getElementById('app'),
  ];

  status.textContent = 'Loading...';
  setRefreshing(true, refreshTargets);
  leadsUpdateCompareToggle();
  try {
    // The previous-period comparison fetch (if any) has no dependency on the
    // primary range's response, so it runs alongside it instead of after --
    // halving wall-clock time when a Leads comparison is active.
    const [res, spendsRes] = await Promise.all([
      fetch(`/api/clg-regions?startDate=${currentStartDate}&endDate=${currentEndDate}`),
      fetch(`/api/clg-spends?startDate=${currentStartDate}&endDate=${currentEndDate}`),
      leadsFetchPrevIfNeeded(),
    ]);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');

    lastData = data;
    overviewSpendsData = spendsRes.ok ? await spendsRes.json() : null;
    render();
    renderOverview();
    renderOverviewSpends();
    renderTalWidget();
    document.getElementById('lastUpdated').textContent = 'Updated ' + new Date(data.lastUpdated).toLocaleString();
    status.textContent = '';
  } catch (err) {
    status.textContent = 'Error: ' + err.message;
  } finally {
    setRefreshing(false, refreshTargets);
  }
}

function selectRegion(regionKey) {
  activeRegion = regionKey;
  document.getElementById('regionSelectLeads').value = regionKey;
  showSpends(false);
  render();
  renderOverview();
  renderOverviewSpends();
  renderTalWidget();
  smoothScrollTop();
}

document.getElementById('calendarResetBtn').addEventListener('click', resetDateRange);
document.getElementById('calendarPrevBtnLeft').addEventListener('click', () => {
  calendarViewDateLeft = new Date(Date.UTC(calendarViewDateLeft.getUTCFullYear(), calendarViewDateLeft.getUTCMonth() - 1, 1));
  renderCalendar();
});
document.getElementById('calendarNextBtnLeft').addEventListener('click', () => {
  calendarViewDateLeft = new Date(Date.UTC(calendarViewDateLeft.getUTCFullYear(), calendarViewDateLeft.getUTCMonth() + 1, 1));
  renderCalendar();
});
document.getElementById('calendarPrevBtnRight').addEventListener('click', () => {
  calendarViewDateRight = new Date(Date.UTC(calendarViewDateRight.getUTCFullYear(), calendarViewDateRight.getUTCMonth() - 1, 1));
  renderCalendar();
});
document.getElementById('calendarNextBtnRight').addEventListener('click', () => {
  calendarViewDateRight = new Date(Date.UTC(calendarViewDateRight.getUTCFullYear(), calendarViewDateRight.getUTCMonth() + 1, 1));
  renderCalendar();
});
document.getElementById('calendarApplyBtn').addEventListener('click', commitDateRange);
document.getElementById('calendarCancelBtn').addEventListener('click', cancelDraftRange);
document.getElementById('calendarTwoMonths').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-date]');
  if (!btn) return;
  // Without this, renderCalendar()'s innerHTML swap (triggered by
  // handleDayClick below) detaches this very button from the DOM before the
  // click finishes bubbling, which breaks the outside-click listener's
  // `.closest('.date-range-control')` check and closes the popover right
  // after the FIRST (start-date) click -- stopping propagation here means
  // that document-level listener never sees this click at all.
  e.stopPropagation();
  handleDayClick(btn.dataset.date);
});
document.getElementById('quickRangeRow').addEventListener('click', (e) => {
  const btn = e.target.closest('.quick-range-btn');
  if (!btn) return;
  pulseScale(btn);
  if (btn.dataset.preset) applyDatePreset(btn.dataset.preset);
  else applyQuickRange(parseInt(btn.dataset.days, 10));
});

// ---- Date-range popover -- a LinkedIn/Meta-Ads-Campaign-Manager-style
// compact trigger button in the topbar that opens the (unchanged) calendar
// card as a floating panel instead of it sitting permanently on the page.
// Only one Leads/Spends popover is ever open at a time; a selection that
// fully resolves a date (single day, or the 2nd click of a range, or a quick
// preset) closes it automatically -- picking just the start of a range
// leaves it open so the user can then click the end date. ----
function closeAllDatePopovers() {
  document.querySelectorAll('.date-popover').forEach(p => p.classList.add('hidden'));
}
function toggleDatePopover(id, onOpen) {
  const el = document.getElementById(id);
  const wasHidden = el.classList.contains('hidden');
  closeAllDatePopovers();
  if (wasHidden) {
    el.classList.remove('hidden');
    if (onOpen) onOpen();
  }
}
// Reopening always discards any abandoned draft/half-made click (a start
// date picked but never confirmed with Update) and shows whatever range is
// actually applied -- an unconfirmed draft is never silently carried over.
document.getElementById('dateRangeTriggerLeads').addEventListener('click', (e) => {
  e.stopPropagation();
  toggleDatePopover('datePopoverLeads', () => {
    pendingRangeStart = null;
    draftStartDate = null;
    draftEndDate = null;
    renderCalendar();
  });
});
document.getElementById('dateRangeTriggerSpends').addEventListener('click', (e) => {
  e.stopPropagation();
  toggleDatePopover('datePopoverSpends', () => {
    spendsPendingRangeStart = null;
    spendsDraftStartDate = null;
    spendsDraftEndDate = null;
    spendsRenderCalendar();
  });
});
document.addEventListener('click', (e) => {
  if (e.target.closest('.date-range-control') || e.target.closest('.compare-custom-control')) return;
  closeAllDatePopovers();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeAllDatePopovers();
});

function formatDateRangeLabel(start, end) {
  return start === end
    ? DATE_LABEL_FMT.format(new Date(start + 'T00:00:00Z'))
    : `${RANGE_DATE_FMT.format(new Date(start + 'T00:00:00Z'))} – ${RANGE_DATE_FMT.format(new Date(end + 'T00:00:00Z'))}`;
}

document.getElementById('regionSelectLeads').addEventListener('change', (e) => selectRegion(e.target.value));

document.getElementById('spendsBox').addEventListener('click', () => showSpends(true));
document.getElementById('spendsBackBtn').addEventListener('click', () => showSpends(false));

document.getElementById('stageTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.subtab');
  if (!btn) return;
  activeStage = btn.dataset.stage;
  document.querySelectorAll('#stageTabs .subtab').forEach(t => t.classList.toggle('active', t === btn));
  pulseScale(btn);
  render();
});

// ---- Click-to-see-leads popup (Leads tab's Status cells only -- see
// includeRecordDetail in the API; other stages' cells never carry records). ----
const leadModal = document.getElementById('leadModal');
const leadModalTitle = leadModal.querySelector('.modal-title');
const modalCountBadge = document.getElementById('modalCountBadge');
const modalTimeline = document.getElementById('modalTimeline');
const modalFooter = document.getElementById('modalFooter');
const modalEmpty = document.getElementById('modalEmpty');
const modalSearchInput = document.getElementById('modalSearchInput');
let modalAllRecords = [];
// 'lead' (default) or 'account' -- set by whichever open*Modal call opened
// the popup, read by modalRenderRecords to pick the right card layout/search
// fields/wording. Both share the same modal DOM and search/close plumbing.
let modalKind = 'lead';

function modalRecordCardHtml(r) {
  const baseUrl = (lastData && lastData.sfRecordBaseUrl) || '';
  return `
    <div class="modal-timeline-item">
      <span class="modal-timeline-dot">&#128100;</span>
      <div class="modal-record-card">
        <div class="modal-record-top">
          <span class="modal-record-company">${escapeHtml(r.company) || '&mdash;'}</span>
          <span class="modal-record-tag">Lead</span>
        </div>
        <a class="modal-record-name" href="${baseUrl}/${encodeURIComponent(r.id)}" target="_blank" rel="noopener">${escapeHtml(r.name)}</a>
        <div class="modal-record-title">${escapeHtml(r.title) || '&mdash;'}</div>
        <div class="modal-record-source"><span>Source:</span> ${escapeHtml(r.source) || '&mdash;'}</div>
      </div>
    </div>
  `;
}

// Total Accounts' click-through -- a Salesforce-linked Account, not a Lead,
// so it shows the fields that popup is actually asked to show. Account Name
// leads (as the Salesforce link, same as every other record kind here),
// Industry Vertical follows -- repeating "Ecomm/D2C" as the top line across
// every card in the list read as one undifferentiated block, since it's the
// one field nearly every account in this list shares; the account's own name
// is what actually distinguishes each card. Potential MRR sits below that,
// Priority stays as the top-right badge.
function modalAccountCardHtml(r) {
  const baseUrl = (lastData && lastData.sfRecordBaseUrl) || '';
  return `
    <div class="modal-timeline-item">
      <span class="modal-timeline-dot">&#127970;</span>
      <div class="modal-record-card">
        <div class="modal-record-top">
          <a class="modal-record-company" href="${baseUrl}/${encodeURIComponent(r.id)}" target="_blank" rel="noopener">${escapeHtml(r.name)}</a>
          <span class="modal-record-tag">${escapeHtml(r.priority) || 'Account'}</span>
        </div>
        <div class="modal-record-title">${escapeHtml(r.industryVertical) || '&mdash;'}</div>
        <div class="modal-record-source"><span>Potential MRR:</span> ${escapeHtml(r.potentialMrr) || '&mdash;'}</div>
      </div>
    </div>
  `;
}

function modalRenderRecords() {
  const isAccount = modalKind === 'account';
  const noun = isAccount ? 'account' : 'lead';
  const searchFields = isAccount
    ? (r) => [r.name, r.priority, r.industryVertical]
    : (r) => [r.name, r.company, r.title, r.source];
  const query = modalSearchInput.value.trim().toLowerCase();
  const records = query
    ? modalAllRecords.filter(r => searchFields(r).some(v => (v || '').toLowerCase().includes(query)))
    : modalAllRecords;
  modalCountBadge.textContent = `${records.length} ${noun}${records.length === 1 ? '' : 's'}`;
  modalTimeline.innerHTML = records.map(isAccount ? modalAccountCardHtml : modalRecordCardHtml).join('');
  modalEmpty.classList.toggle('hidden', records.length > 0);
  modalFooter.textContent = query
    ? `Showing ${records.length} of ${modalAllRecords.length} ${noun}${modalAllRecords.length === 1 ? '' : 's'} matching "${modalSearchInput.value.trim()}"`
    : `Showing ${records.length} ${noun}${records.length === 1 ? '' : 's'} in this cell`;
  if (gsapReady) animateRowsIn(modalTimeline.querySelectorAll('.modal-timeline-item'));
}

function openLeadModal(records, statusLabel, kind = 'lead') {
  modalKind = kind;
  leadModalTitle.textContent = statusLabel;
  modalAllRecords = records;
  modalSearchInput.value = '';
  modalSearchInput.placeholder = kind === 'account'
    ? 'Search by account name, priority, or vertical…'
    : 'Search by name, company, or source…';
  modalRenderRecords();
  leadModal.classList.remove('hidden');
  const box = leadModal.querySelector('.modal-box');
  if (gsapReady) {
    gsap.fromTo(leadModal, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.25, ease: 'power2.out' });
    gsap.fromTo(box, { autoAlpha: 0, y: 24, scale: 0.94 }, { autoAlpha: 1, y: 0, scale: 1, duration: 0.4, ease: 'back.out(1.7)' });
    animateRowsIn(modalTimeline.querySelectorAll('.modal-timeline-item'));
  }
}

function closeLeadModal() {
  if (!gsapReady) {
    leadModal.classList.add('hidden');
    return;
  }
  const box = leadModal.querySelector('.modal-box');
  gsap.to(box, { autoAlpha: 0, y: 16, scale: 0.94, duration: 0.2, ease: 'power2.in' });
  gsap.to(leadModal, { autoAlpha: 0, duration: 0.22, ease: 'power2.in', onComplete: () => leadModal.classList.add('hidden') });
}

modalSearchInput.addEventListener('input', modalRenderRecords);

// Delegated on `document`, not `#app` -- the TAL/Non-TAL widget's cards live
// in the static #leadsView markup outside #app (which only ever holds the
// pivot table), so a listener scoped to #app would miss clicks on them.
document.addEventListener('click', (e) => {
  const cell = e.target.closest('.pivot-cell-clickable');
  if (!cell || !cell.dataset.records) return;
  const records = JSON.parse(decodeURIComponent(cell.dataset.records));
  const statusLabel = cell.dataset.statusLabel || '';
  openLeadModal(records, statusLabel, cell.dataset.recordKind === 'account' ? 'account' : 'lead');
});

leadModal.querySelector('.modal-close').addEventListener('click', closeLeadModal);
leadModal.addEventListener('click', (e) => {
  if (e.target === leadModal) closeLeadModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeLeadModal();
});

// ==== Spends tab (LinkedIn + Meta campaign performance) ====================
// Mirrors the Leads dashboard's calendar/region-filter/radar UX exactly, but
// with fully independent state -- it's a separate view (api/clg-spends.js),
// not tied to the Leads dashboard's date range/region selection.
let spendsActiveRegion = 'India';
let spendsActiveChannel = 'linkedin';
let spendsLastData = null;
let spendsGroupExpanded = true;
let spendsExpandedCampaigns = new Set();
let spendsSearchQuery = '';
// Campaign names checked via the row checkboxes -- when non-empty, KPI tiles
// and the footer total narrow to just these (still within whatever the
// search box currently matches), instead of the full region/channel totals.
let spendsSelectedCampaigns = new Set();

// Table sort -- null key means "as returned" (the sheet's own order).
// sortKey is 'name' for the Campaign Name column, or a SPENDS_TABLE_COLUMNS
// entry's key (e.g. 'leadCount') for any other sortable header.
let spendsSortKey = null;
let spendsSortDir = 'desc';

let spendsPendingRangeStart = null;
let spendsDraftStartDate = null;
let spendsDraftEndDate = null;
let spendsHasExplicitSelection = false;
let spendsStartDate = SPENDS_DEFAULT_START_DATE;
let spendsEndDate = SPENDS_DEFAULT_END_DATE;
let spendsCalendarViewDateLeft = monthStartUTC(spendsEndDate, -1);
let spendsCalendarViewDateRight = monthStartUTC(spendsEndDate, 0);

// ---- Period-over-period comparison -- two modes:
//   'auto'   -- previous N days immediately before the selected range, only
//               offered when that range is 1-30 days (otherwise "previous
//               period" is ambiguous, so no auto button is shown at all).
//   'custom' -- an arbitrary comparison range the user picks on its own mini
//               calendar, independent of the primary range's length -- lets
//               e.g. "this month" be compared against "the same month last
//               year" or any other hand-picked window.
// Only one mode is active at a time; spendsPrevData holds whichever
// comparison period's full /api/clg-spends response is currently loaded. ----
let spendsComparePeriod = null; // detected {days, label} for the current range, or null
let spendsCompareMode = null; // null | 'auto' | 'custom'
let spendsPrevData = null;
let spendsCustomCompareStart = null;
let spendsCustomCompareEnd = null;

// Generic -- shared by the Spends tab's and the Leads tab's "Compare with
// previous N days" auto-detect (only offered for a 1-30 day primary range,
// otherwise "previous period" is ambiguous).
function detectComparePeriod(startDate, endDate) {
  const start = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');
  const days = Math.round((end - start) / 86400000) + 1;
  if (days < 1 || days > 30) return null;
  return { days, label: `${days} day${days === 1 ? '' : 's'}` };
}

function addDaysToDateStr(dateStr, delta) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

// pct is null when there's nothing to compare (no prior-period figure at
// all) -- callers render nothing in that case, vs. an explicit "NEW" badge
// when the prior period exists but this specific campaign didn't.
function deltaBadgeHtml(curr, prev) {
  if (prev === undefined || prev === null) return '';
  if (prev === 0) return curr === 0 ? '' : '<span class="kpi-delta kpi-delta-new">NEW</span>';
  const pct = ((curr - prev) / prev) * 100;
  const isUp = pct >= 0;
  const cls = isUp ? 'kpi-delta-up' : 'kpi-delta-down';
  const arrow = isUp ? '&#9650;' : '&#9660;';
  return `<span class="kpi-delta ${cls}">${arrow} ${Math.abs(pct).toFixed(0)}%</span>`;
}

function spendsGetPrevChannelData() {
  if (!spendsCompareMode || !spendsPrevData) return null;
  return spendsGetChannelData(spendsPrevData, spendsActiveRegion, spendsActiveChannel);
}

// Runs on every load (region/channel/date-range change) -- keeps the 'auto'
// button's availability/label in sync with the current primary range, and
// auto-disables 'auto' mode if the range grows past 30 days (undefined
// "previous period"). A 'custom' comparison is independent of the primary
// range's length, so it's left alone here.
function spendsUpdateCompareToggle() {
  spendsComparePeriod = detectComparePeriod(spendsStartDate, spendsEndDate);
  const btn = document.getElementById('spendsCompareToggle');
  const closeBtn = document.getElementById('spendsCompareClose');
  const customBtn = document.getElementById('spendsCompareCustomBtn');

  if (!spendsComparePeriod) {
    btn.classList.add('hidden');
    if (spendsCompareMode === 'auto') { spendsCompareMode = null; spendsPrevData = null; }
  } else {
    btn.textContent = `Compare with previous ${spendsComparePeriod.label}`;
    btn.classList.remove('hidden');
    btn.classList.toggle('active', spendsCompareMode === 'auto');
  }

  customBtn.classList.toggle('active', spendsCompareMode === 'custom');
  document.getElementById('spendsCompareCustomLabel').textContent = spendsCompareMode === 'custom'
    ? `Comparing vs ${RANGE_DATE_FMT.format(new Date(spendsCustomCompareStart + 'T00:00:00Z'))} – ${RANGE_DATE_FMT.format(new Date(spendsCustomCompareEnd + 'T00:00:00Z'))}`
    : 'Compare with custom range';

  closeBtn.classList.toggle('hidden', !spendsCompareMode);
}

async function spendsFetchPrevIfNeeded() {
  // 'custom' mode's data is fixed to the user-picked comparison range, not
  // tied to the primary range -- only 'auto' mode needs a refetch here.
  if (spendsCompareMode !== 'auto' || !spendsComparePeriod) return;
  const prevEnd = addDaysToDateStr(spendsStartDate, -1);
  const prevStart = addDaysToDateStr(prevEnd, -(spendsComparePeriod.days - 1));
  try {
    const res = await fetch(`/api/clg-spends?startDate=${prevStart}&endDate=${prevEnd}`);
    const data = await res.json();
    spendsPrevData = res.ok ? data : null;
  } catch (err) {
    spendsPrevData = null;
  }
}

function spendsRenderCalendarHeader() {
  document.getElementById('dateRangeTriggerLabelSpends').textContent = formatDateRangeLabel(spendsStartDate, spendsEndDate);

  const hasDraft = spendsDraftStartDate && spendsDraftEndDate;
  const hasRange = spendsHasExplicitSelection && spendsStartDate !== spendsEndDate;
  const rangePill = document.getElementById('spendsCalendarRangePill');
  if (hasDraft) {
    rangePill.textContent = spendsDraftStartDate === spendsDraftEndDate
      ? DATE_LABEL_FMT.format(new Date(spendsDraftEndDate + 'T00:00:00Z'))
      : `${RANGE_DATE_FMT.format(new Date(spendsDraftStartDate + 'T00:00:00Z'))} – ${RANGE_DATE_FMT.format(new Date(spendsDraftEndDate + 'T00:00:00Z'))}`;
    rangePill.classList.remove('hidden');
  } else if (spendsPendingRangeStart) {
    rangePill.textContent = `From ${RANGE_DATE_FMT.format(new Date(spendsPendingRangeStart + 'T00:00:00Z'))} — pick end date`;
    rangePill.classList.remove('hidden');
  } else if (hasRange) {
    rangePill.textContent = `${RANGE_DATE_FMT.format(new Date(spendsStartDate + 'T00:00:00Z'))} – ${RANGE_DATE_FMT.format(new Date(spendsEndDate + 'T00:00:00Z'))}`;
    rangePill.classList.remove('hidden');
  } else if (spendsHasExplicitSelection) {
    rangePill.textContent = DATE_LABEL_FMT.format(new Date(spendsEndDate + 'T00:00:00Z'));
    rangePill.classList.remove('hidden');
  } else {
    rangePill.classList.add('hidden');
  }

  document.getElementById('spendsCalendarResetBtn').classList.toggle('hidden', !(spendsPendingRangeStart || spendsHasExplicitSelection));
  document.getElementById('spendsCalendarHelperText').classList.toggle('hidden', !!spendsPendingRangeStart || !!hasDraft);
  document.getElementById('spendsCalendarApplyRow').classList.toggle('hidden', !hasDraft);
}

function spendsRenderCalendarMonthGrid(viewDate, gridId) {
  const year = viewDate.getUTCFullYear();
  const month = viewDate.getUTCMonth();
  const firstOfMonth = new Date(Date.UTC(year, month, 1));
  const leadingBlanks = (firstOfMonth.getUTCDay() + 6) % 7;
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

  const todayStr = new Date().toISOString().slice(0, 10);
  const hasDraft = spendsDraftStartDate && spendsDraftEndDate;
  const displayStart = hasDraft ? spendsDraftStartDate : spendsStartDate;
  const displayEnd = hasDraft ? spendsDraftEndDate : spendsEndDate;
  const hasSelection = hasDraft || spendsHasExplicitSelection;
  const hasRange = hasSelection && displayStart !== displayEnd;
  const cells = [];
  for (let i = 0; i < leadingBlanks; i++) cells.push('<span class="calendar-day calendar-day-blank"></span>');
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const isFuture = dateStr > todayStr;
    const isToday = dateStr === todayStr;
    const isPending = spendsPendingRangeStart === dateStr;
    const isEdge = hasSelection && !spendsPendingRangeStart && (dateStr === displayStart || dateStr === displayEnd);
    const isBetween = hasRange && !spendsPendingRangeStart && dateStr > displayStart && dateStr < displayEnd;

    const classes = ['calendar-day'];
    if (isFuture) classes.push('calendar-day-future');
    else if (isPending) classes.push('calendar-day-pending');
    else if (isEdge) classes.push('calendar-day-selected');
    else if (isBetween) classes.push('calendar-day-in-range');
    else if (isToday) classes.push('calendar-day-today');

    const attrs = isFuture ? 'disabled' : `data-date="${dateStr}"`;
    const dot = isToday && !isPending && !isEdge ? '<span class="calendar-day-dot"></span>' : '';
    cells.push(`<button type="button" class="${classes.join(' ')}" ${attrs}>${day}${dot}</button>`);
  }
  document.getElementById(gridId).innerHTML = cells.join('');
}

function spendsRenderCalendar() {
  spendsRenderCalendarHeader();
  spendsUpdateQuickRangeActive();
  document.getElementById('spendsCalendarMonthLabelLeft').textContent = CALENDAR_MONTH_FMT.format(spendsCalendarViewDateLeft).toUpperCase();
  document.getElementById('spendsCalendarMonthLabelRight').textContent = CALENDAR_MONTH_FMT.format(spendsCalendarViewDateRight).toUpperCase();
  spendsRenderCalendarMonthGrid(spendsCalendarViewDateLeft, 'spendsCalendarGridLeft');
  spendsRenderCalendarMonthGrid(spendsCalendarViewDateRight, 'spendsCalendarGridRight');
}

function spendsHandleDayClick(dateStr) {
  if (!spendsPendingRangeStart) {
    spendsPendingRangeStart = dateStr;
    spendsRenderCalendar();
    return;
  }
  spendsDraftStartDate = spendsPendingRangeStart < dateStr ? spendsPendingRangeStart : dateStr;
  spendsDraftEndDate = spendsPendingRangeStart < dateStr ? dateStr : spendsPendingRangeStart;
  spendsPendingRangeStart = null;
  spendsRenderCalendar();
  pulseScale(document.querySelector('#spendsCalendarTwoMonths .calendar-day-selected'));
}

function spendsCommitDateRange() {
  if (spendsDraftStartDate && spendsDraftEndDate) {
    spendsStartDate = spendsDraftStartDate;
    spendsEndDate = spendsDraftEndDate;
    spendsHasExplicitSelection = true;
  }
  spendsDraftStartDate = null;
  spendsDraftEndDate = null;
  spendsRenderCalendar();
  spendsLoad();
  closeAllDatePopovers();
}

function spendsCancelDraftRange() {
  spendsPendingRangeStart = null;
  spendsDraftStartDate = null;
  spendsDraftEndDate = null;
  spendsRenderCalendar();
  closeAllDatePopovers();
}

function spendsResetDateRange() {
  spendsPendingRangeStart = null;
  spendsDraftStartDate = null;
  spendsDraftEndDate = null;
  spendsHasExplicitSelection = false;
  spendsStartDate = SPENDS_DEFAULT_START_DATE;
  spendsEndDate = SPENDS_DEFAULT_END_DATE;
  spendsCalendarViewDateLeft = monthStartUTC(spendsEndDate, -1);
  spendsCalendarViewDateRight = monthStartUTC(spendsEndDate, 0);
  spendsRenderCalendar();
  spendsLoad();
  closeAllDatePopovers();
}

// ---- Region filter: a compact dropdown (replaces the old donut+legend
// widget), rebuilt whenever the active channel changes since Email/WhatsApp
// carry an extra MEA region LinkedIn/Meta Ads don't have (see
// SPENDS_MESSAGING_REGIONS) -- plus "All Regions". ----
function spendsPopulateRegionSelect() {
  const sel = document.getElementById('regionSelectSpends');
  const options = ['All', ...spendsRegionsForChannel().map(r => r.key)];
  sel.innerHTML = options.map(key => `<option value="${key}">${key === 'All' ? 'All Regions' : escapeHtml(key)}</option>`).join('');
  if (!options.includes(spendsActiveRegion)) spendsActiveRegion = 'All';
  sel.value = spendsActiveRegion;
}

function spendsClearCampaignSearch() {
  clearTimeout(spendsSearchDebounceTimer);
  spendsSearchQuery = '';
  const input = document.getElementById('spendsCampaignSearch');
  if (input) input.value = '';
  const clearBtn = document.getElementById('spendsCampaignSearchClear');
  if (clearBtn) clearBtn.classList.add('hidden');
}

function spendsSelectRegion(regionKey) {
  spendsActiveRegion = regionKey;
  document.getElementById('regionSelectSpends').value = regionKey;
  spendsClearCampaignSearch();
  spendsClearSelection();
  spendsRender();
}

// ---- "All Regions" aggregation (Spends tab only -- every region's channel
// data shares the exact same shape, unlike the Leads dashboard's per-region
// report structures, so this is a safe plain sum). Raw counts are summed
// then rates/percentages are RE-DERIVED from those sums, matching the same
// "never average derived rates" rule api/clg-spends.js already follows. ----
function spendsDeriveRatesClient(t) {
  const ctr = t.impressions > 0 ? (t.clicks / t.impressions) * 100 : 0;
  const cpm = t.impressions > 0 ? (t.spend / t.impressions) * 1000 : 0;
  const cpc = t.clicks > 0 ? t.spend / t.clicks : 0;
  return { ...t, ctr, cpm, cpc };
}
function spendsDeriveMessagingRatesClient(t) {
  const deliveredPct = t.sent > 0 ? (t.delivered / t.sent) * 100 : 0;
  const uniqueOpenedPct = t.delivered > 0 ? (t.uniqueOpened / t.delivered) * 100 : 0;
  const uniqueClickedPct = t.delivered > 0 ? (t.uniqueClicked / t.delivered) * 100 : 0;
  return { ...t, deliveredPct, uniqueOpenedPct, uniqueClickedPct };
}
const SPENDS_TOTAL_KEYS = {
  paid: ['spend', 'clicks', 'impressions'],
  messaging: ['sent', 'delivered', 'totalOpened', 'uniqueOpened', 'totalClicked', 'uniqueClicked'],
};

function spendsAggregateChannel(dataset, channel) {
  const isMsg = MESSAGING_CHANNELS.has(channel);
  const regions = (isMsg ? SPENDS_MESSAGING_REGIONS : SPENDS_PAID_REGIONS).map(r => r.key);
  const totalKeys = SPENDS_TOTAL_KEYS[isMsg ? 'messaging' : 'paid'];
  const totals = {};
  totalKeys.forEach(k => { totals[k] = 0; });
  const campaigns = [];
  for (const region of regions) {
    const regionData = dataset.regions[region];
    if (!regionData) continue;
    const channelData = regionData[channel];
    campaigns.push(...channelData.campaigns);
    for (const k of totalKeys) totals[k] += channelData.kpi[k] || 0;
  }
  const kpi = isMsg ? spendsDeriveMessagingRatesClient(totals) : spendsDeriveRatesClient(totals);
  campaigns.sort((a, b) => isMsg ? b.sent - a.sent : b.spend - a.spend);
  return { kpi, campaigns };
}

// Re-derives a KPI object from an arbitrary subset of campaigns (search
// results, a checkbox selection, or both) -- same "sum raw counts, re-derive
// rates" rule as spendsAggregateChannel, just over a caller-picked list
// instead of every campaign in the channel.
function spendsComputeKpiForCampaigns(campaignsList, isMsg) {
  const totalKeys = SPENDS_TOTAL_KEYS[isMsg ? 'messaging' : 'paid'];
  const totals = {};
  totalKeys.forEach(k => { totals[k] = 0; });
  for (const c of campaignsList) for (const k of totalKeys) totals[k] += c[k] || 0;
  return isMsg ? spendsDeriveMessagingRatesClient(totals) : spendsDeriveRatesClient(totals);
}
// Resolves the channel data to render, whether that's one region's own
// response or the "All Regions" aggregate above -- every call site that used
// to read `dataset.regions[region][channel]` directly now goes through here.
function spendsGetChannelData(dataset, region, channel) {
  if (!dataset) return null;
  return region === 'All' ? spendsAggregateChannel(dataset, channel) : dataset.regions[region][channel];
}

const SPENDS_RADAR_MESSAGES = [
  'SCANNING CAMPAIGNS...', 'CAMPAIGN DETECTED', 'ANALYSING SPEND...', 'SIGNAL ACQUIRED',
  'SCANNING CAMPAIGNS...', 'TRACKING PERFORMANCE...', 'DATA SYNCED',
];
let spendsRadarMsgIdx = 0;
setInterval(() => {
  spendsRadarMsgIdx = (spendsRadarMsgIdx + 1) % SPENDS_RADAR_MESSAGES.length;
  const el = document.getElementById('spendsRadarMessage');
  if (el) el.textContent = `▶ ${SPENDS_RADAR_MESSAGES[spendsRadarMsgIdx]}`;
}, 2200);

// ---- Channel-specific presentation -- LinkedIn/Meta Ads are paid (spend,
// clicks, impressions, CTR/CPM/CPC); Email/WhatsApp are free sends (no spend
// at all), so they get their own KPI-tile and table-column configs instead of
// forcing send/delivery counts through spend-shaped labels. ----
const SPENDS_KPI_CONFIG = {
  paid: [
    { valueId: 'spendsTotalSpend', deltaId: 'spendsTotalSpendDelta', labelId: 'spendsKpi1Label', captionId: 'spendsKpi1Caption', label: 'Total Spend', caption: 'this period', get: k => k.spend, fmt: fmtCurrency },
    { valueId: 'spendsTotalClicks', deltaId: 'spendsTotalClicksDelta', labelId: 'spendsKpi2Label', captionId: 'spendsKpi2Caption', label: 'Total Clicks', caption: 'this period', get: k => k.clicks, fmt: fmtInt },
    { valueId: 'spendsCtr', deltaId: 'spendsCtrDelta', labelId: 'spendsKpi3Label', captionId: 'spendsKpi3Caption', label: 'CTR', caption: 'click-through rate', get: k => k.ctr, fmt: v => `${fmtDec(v)}%` },
    { valueId: 'spendsCpm', deltaId: 'spendsCpmDelta', labelId: 'spendsKpi4Label', captionId: 'spendsKpi4Caption', label: 'CPM', caption: 'cost per 1000 impr.', get: k => k.cpm, fmt: fmtCurrency },
  ],
  messaging: [
    { valueId: 'spendsTotalSpend', deltaId: 'spendsTotalSpendDelta', labelId: 'spendsKpi1Label', captionId: 'spendsKpi1Caption', label: 'Total Sent', caption: 'this period', get: k => k.sent, fmt: fmtInt },
    { valueId: 'spendsTotalClicks', deltaId: 'spendsTotalClicksDelta', labelId: 'spendsKpi2Label', captionId: 'spendsKpi2Caption', label: 'Delivered', caption: 'this period', get: k => k.delivered, fmt: fmtInt },
    { valueId: 'spendsCtr', deltaId: 'spendsCtrDelta', labelId: 'spendsKpi3Label', captionId: 'spendsKpi3Caption', label: 'Unique Opened %', caption: 'of delivered', get: k => k.uniqueOpenedPct, fmt: v => `${fmtDec(v)}%` },
    { valueId: 'spendsCpm', deltaId: 'spendsCpmDelta', labelId: 'spendsKpi4Label', captionId: 'spendsKpi4Caption', label: 'Unique Clicked %', caption: 'of delivered', get: k => k.uniqueClickedPct, fmt: v => `${fmtDec(v)}%` },
  ],
};

// 'leadCount'/'ndlCount'/'dlCount' are campaign -> Leads-tab attributions
// (matched on the lead's Source field against the campaign's own name -- see
// buildLeadsBySource in api/clg-spends.js), not metrics native to the ad
// platform sheets, so they're flagged separately (isClickableCount) to render
// as a clickable cell reusing the existing lead-detail modal, same as the
// Leads tab's Status cells. NDL = Non Demo Lead (NDL__c), DL = Disqualified
// Lead (Status === 'Disqualified MQL').
const SPENDS_TABLE_COLUMNS = {
  paid: [
    { key: 'spend', label: 'Amount Spent', fmt: fmtCurrency },
    { key: 'clicks', label: 'Clicks', fmt: fmtInt },
    { key: 'impressions', label: 'Impressions', fmt: fmtInt },
    { key: 'ctr', label: 'CTR', fmt: v => `${fmtDec(v)}%` },
    { key: 'cpm', label: 'CPM', fmt: fmtCurrency },
    { key: 'cpc', label: 'CPC', fmt: fmtCurrency },
    { key: 'leadCount', recordsKey: 'leadRecords', label: 'Leads', fmt: fmtInt, isClickableCount: true },
    { key: 'ndlCount', recordsKey: 'ndlRecords', label: 'NDL', fmt: fmtInt, isClickableCount: true },
    { key: 'dlCount', recordsKey: 'dlRecords', label: 'DL', fmt: fmtInt, isClickableCount: true },
  ],
  messaging: [
    { key: 'sent', label: 'Sent', fmt: fmtInt },
    { key: 'delivered', label: 'Delivered', fmt: fmtInt },
    { key: 'deliveredPct', label: 'Delivered %', fmt: v => `${fmtDec(v)}%` },
    { key: 'totalOpened', label: 'Total Opened/Read', fmt: fmtInt },
    { key: 'uniqueOpened', label: 'Unique Opened', fmt: fmtInt },
    { key: 'uniqueOpenedPct', label: 'Unique Opened %', fmt: v => `${fmtDec(v)}%` },
    { key: 'totalClicked', label: 'Total Clicked', fmt: fmtInt },
    { key: 'uniqueClicked', label: 'Unique Clicked', fmt: fmtInt },
    { key: 'uniqueClickedPct', label: 'Unique Clicked %', fmt: v => `${fmtDec(v)}%` },
    { key: 'leadCount', recordsKey: 'leadRecords', label: 'Leads', fmt: fmtInt, isClickableCount: true },
    { key: 'ndlCount', recordsKey: 'ndlRecords', label: 'NDL', fmt: fmtInt, isClickableCount: true },
    { key: 'dlCount', recordsKey: 'dlRecords', label: 'DL', fmt: fmtInt, isClickableCount: true },
  ],
};

function spendsRenderRadar(kpi, campaignCount) {
  const blipCount = Math.max(1, Math.min(RADAR_BLIP_SLOTS.length, Math.ceil(campaignCount / 2)));
  const g = document.getElementById('spendsRadarBlips');
  g.innerHTML = RADAR_BLIP_SLOTS.slice(0, blipCount).map((slot, i) => {
    const [x, y] = radarToXY(slot.deg, slot.r);
    const color = i % 2 ? '#ffd166' : '#ff6b6b';
    const delay = `${i * 0.4}s`;
    return `
      <circle class="radar-blip-ring" cx="${x}" cy="${y}" r="2" style="stroke:${color}; animation-delay:${delay}" />
      <circle class="radar-blip-ring radar-blip-ring-2" cx="${x}" cy="${y}" r="2" style="stroke:${color}; animation-delay:${i * 0.4 + 0.8}s" />
      <circle class="radar-blip-dot" cx="${x}" cy="${y}" r="2.5" style="fill:${color}" />
    `;
  }).join('');

  const isMsg = spendsIsMessaging();
  animateNumberText(document.getElementById('spendsRadarCampaigns'), campaignCount);
  document.getElementById('spendsRadarImpressionsLabel').textContent = isMsg ? 'DELIVERED' : 'IMPRESSIONS';
  animateNumberText(document.getElementById('spendsRadarImpressions'), isMsg ? kpi.delivered : kpi.impressions);
  document.getElementById('spendsRadarCpcLabel').textContent = isMsg ? 'UNIQUE CLICK %' : 'AVG CPC';
  if (isMsg) animateNumberText(document.getElementById('spendsRadarCpc'), kpi.uniqueClickedPct, (v) => `${fmtDec(v)}%`);
  else animateNumberText(document.getElementById('spendsRadarCpc'), kpi.cpc, fmtCurrency);
  document.getElementById('spendsRadarWindow').textContent = `▶ SCAN WINDOW: ${spendsStartDate} → ${spendsEndDate}`;

  const channelLabels = { linkedin: 'LINKEDIN', meta: 'META', email: 'EMAIL', whatsapp: 'WHATSAPP' };
  document.getElementById('spendsRadarSyncLine').innerHTML = `&#9654; ${channelLabels[spendsActiveChannel]} SYNCED <span class="radar-dot-ok">&#9679;</span>`;
}

function spendsToggleGroup() {
  spendsGroupExpanded = !spendsGroupExpanded;
  spendsRenderTable();
}

function spendsToggleCampaign(name) {
  if (spendsExpandedCampaigns.has(name)) spendsExpandedCampaigns.delete(name);
  else spendsExpandedCampaigns.add(name);
  spendsRenderTable();
}

// Renders a Leads/NDL/DL column's cell -- clickable (reusing the same lead-
// detail modal as the Leads tab's Status cells) when the campaign actually
// produced records for that stat, a plain 0 otherwise, and a dash on creative
// rows (the campaign -> lead attribution is campaign-level only; a lead's
// Source field holds the campaign name, never a specific creative).
function spendsClickableCountCellHtml(col, record) {
  const records = record[col.recordsKey];
  if (!records) return `<td class="spends-td-nolead">&mdash;</td>`;
  const count = record[col.key] || 0;
  if (count <= 0) return `<td>${col.fmt(count)}</td>`;
  const dataRecords = encodeURIComponent(JSON.stringify(records));
  return `<td><span class="pivot-cell-clickable" data-records="${dataRecords}" data-status-label="${escapeHtml(col.label)} from ${escapeHtml(record.name)}">${col.fmt(count)}</span></td>`;
}

function spendsToggleCampaignSelected(name, checked) {
  if (checked) spendsSelectedCampaigns.add(name);
  else spendsSelectedCampaigns.delete(name);
  spendsRenderTable(true);
}

function spendsClearSelection() {
  spendsSelectedCampaigns.clear();
}

function spendsRenderTable(skipRowAnim) {
  if (!spendsLastData) return;
  const channelData = spendsGetChannelData(spendsLastData, spendsActiveRegion, spendsActiveChannel);
  const allCampaigns = channelData.campaigns;
  const query = spendsSearchQuery.trim().toLowerCase();
  const searchFiltered = query ? allCampaigns.filter(c => c.name.toLowerCase().includes(query)) : allCampaigns;
  // Ascending/descending sort by whichever column header was last clicked
  // (see spendsTableHead's click handler below) -- 'name' sorts the Campaign
  // Name column alphabetically, any other key is a numeric SPENDS_TABLE_
  // COLUMNS field (Leads, NDL, DL, Amount Spent, etc).
  const campaigns = spendsSortKey ? [...searchFiltered].sort((a, b) => {
    const av = spendsSortKey === 'name' ? a.name.toLowerCase() : (a[spendsSortKey] || 0);
    const bv = spendsSortKey === 'name' ? b.name.toLowerCase() : (b[spendsSortKey] || 0);
    if (av < bv) return spendsSortDir === 'asc' ? -1 : 1;
    if (av > bv) return spendsSortDir === 'asc' ? 1 : -1;
    return 0;
  }) : searchFiltered;
  const isMsg = spendsIsMessaging();

  // Totals (KPI tiles + footer row) reflect the checkbox selection when one
  // exists (scoped to whatever the search currently matches), else just the
  // search-filtered rows, else the whole channel -- this is also the fix for
  // totals previously always showing the full unfiltered channel regardless
  // of an active search.
  const hasSelection = spendsSelectedCampaigns.size > 0;
  const effectiveCampaigns = hasSelection ? campaigns.filter(c => spendsSelectedCampaigns.has(c.name)) : campaigns;
  const kpi = spendsComputeKpiForCampaigns(effectiveCampaigns, isMsg);

  const prevChannelData = spendsGetPrevChannelData();
  const prevByName = new Map((prevChannelData ? prevChannelData.campaigns : []).map(c => [c.name, c]));
  // Only render a delta at all once comparison is on for this range -- an
  // undefined prev value (vs. a real 0) tells deltaBadgeHtml to render nothing.
  const prevFor = (name, key) => prevChannelData ? ((prevByName.get(name) || { [key]: 0 })[key]) : undefined;
  const prevKpi = prevChannelData
    ? spendsComputeKpiForCampaigns(effectiveCampaigns.map(c => prevByName.get(c.name) || {}), isMsg)
    : null;

  spendsUpdateKpiTiles(kpi, prevKpi);

  const cols = SPENDS_TABLE_COLUMNS[isMsg ? 'messaging' : 'paid'];

  const sortArrow = (key) => spendsSortKey !== key ? '' : (spendsSortDir === 'asc' ? ' &#9650;' : ' &#9660;');
  document.getElementById('spendsTableHead').innerHTML = `
    <tr>
      <th class="spends-th-check"><input type="checkbox" id="spendsSelectAllCheckbox" title="Select all"></th>
      <th class="pin pin-quarter spends-th-name spends-th-sortable" data-sort-key="name">Campaign Name${sortArrow('name')}</th>
      ${cols.map(c => `<th class="spends-th-sortable" data-sort-key="${c.key}">${escapeHtml(c.label)}${sortArrow(c.key)}</th>`).join('')}
    </tr>
  `;
  document.getElementById('spendsTableHead').onclick = (e) => {
    const th = e.target.closest('.spends-th-sortable');
    if (!th) return;
    const key = th.dataset.sortKey;
    spendsSortDir = spendsSortKey === key ? (spendsSortDir === 'asc' ? 'desc' : 'asc') : 'desc';
    spendsSortKey = key;
    spendsRenderTable(true);
  };
  const selectAllBox = document.getElementById('spendsSelectAllCheckbox');
  const allChecked = campaigns.length > 0 && campaigns.every(c => spendsSelectedCampaigns.has(c.name));
  selectAllBox.checked = allChecked;
  selectAllBox.indeterminate = !allChecked && campaigns.some(c => spendsSelectedCampaigns.has(c.name));
  selectAllBox.onchange = (e) => {
    if (e.target.checked) campaigns.forEach(c => spendsSelectedCampaigns.add(c.name));
    else campaigns.forEach(c => spendsSelectedCampaigns.delete(c.name));
    spendsRenderTable(true);
  };

  const metaHeadline = isMsg ? `${cols[0].fmt(kpi[cols[0].key])} sent` : cols[0].fmt(kpi[cols[0].key]);
  document.getElementById('spendsGroupTitle').textContent = `${spendsActiveRegion} Campaigns`;
  const metaParts = [];
  if (query) metaParts.push(`${campaigns.length} of ${allCampaigns.length} campaign${allCampaigns.length === 1 ? '' : 's'} matching "${spendsSearchQuery.trim()}"`);
  else metaParts.push(`${campaigns.length} campaign${campaigns.length === 1 ? '' : 's'}`);
  if (hasSelection) metaParts.push(`${effectiveCampaigns.length} selected`);
  else metaParts.push(metaHeadline);
  document.getElementById('spendsGroupMeta').textContent = metaParts.join(' · ');
  document.querySelector('.spends-group-arrow').innerHTML = spendsGroupExpanded ? '&#9662;' : '&#9656;';
  document.getElementById('spendsTableWrap').classList.toggle('hidden', !spendsGroupExpanded);

  const tbody = document.getElementById('spendsTableBody');
  tbody.innerHTML = campaigns.length
    ? campaigns.map((c, i) => {
      const hasCreatives = Array.isArray(c.creatives) && c.creatives.length > 0;
      const expanded = hasCreatives && spendsExpandedCampaigns.has(c.name);
      const checked = spendsSelectedCampaigns.has(c.name);
      const campaignRow = `
        <tr class="spends-campaign-row${hasCreatives ? ' has-creatives' : ''}" data-idx="${i}">
          <td class="spends-td-check"><input type="checkbox" class="spends-campaign-checkbox" data-name="${escapeHtml(c.name)}" ${checked ? 'checked' : ''}></td>
          <td class="pin pin-quarter spends-td-name" title="${escapeHtml(c.name)}">
            ${hasCreatives ? `<span class="spends-creative-arrow">${expanded ? '&#9662;' : '&#9656;'}</span>` : '<span class="spends-creative-arrow spends-creative-arrow-empty"></span>'}
            ${escapeHtml(c.name)}
          </td>
          ${cols.map(col => col.isClickableCount ? spendsClickableCountCellHtml(col, c) : `<td>${col.fmt(c[col.key])}${deltaBadgeHtml(c[col.key], prevFor(c.name, col.key))}</td>`).join('')}
        </tr>
      `;
      const creativeRows = expanded ? c.creatives.map(cr => `
        <tr class="spends-creative-row">
          <td class="spends-td-check"></td>
          <td class="pin pin-quarter spends-td-name spends-td-creative" title="${escapeHtml(cr.name)}">${escapeHtml(cr.name)}</td>
          ${cols.map(col => col.isClickableCount ? spendsClickableCountCellHtml(col, cr) : `<td>${col.fmt(cr[col.key])}</td>`).join('')}
        </tr>
      `).join('') : '';
      return campaignRow + creativeRows;
    }).join('')
    : `<tr><td colspan="${cols.length + 2}" class="empty">${query ? `No campaigns match "${escapeHtml(spendsSearchQuery.trim())}".` : 'No matching campaigns in this range.'}</td></tr>`;

  tbody.onclick = (e) => {
    // A click on the Leads/NDL/DL cell is handled by the page-level
    // pivot-cell-clickable listener (opens the lead modal); a click on a
    // checkbox toggles selection -- neither should also toggle this row's
    // creative expand/collapse.
    if (e.target.closest('.pivot-cell-clickable')) return;
    const checkbox = e.target.closest('.spends-campaign-checkbox');
    if (checkbox) { spendsToggleCampaignSelected(checkbox.dataset.name, checkbox.checked); return; }
    const row = e.target.closest('.spends-campaign-row.has-creatives');
    if (!row) return;
    const c = campaigns[+row.dataset.idx];
    if (c) spendsToggleCampaign(c.name);
  };

  const totalLeadCount = effectiveCampaigns.reduce((sum, c) => sum + (c.leadCount || 0), 0);
  const totalNdlCount = effectiveCampaigns.reduce((sum, c) => sum + (c.ndlCount || 0), 0);
  const totalDlCount = effectiveCampaigns.reduce((sum, c) => sum + (c.dlCount || 0), 0);
  const clickableTotals = { leadCount: totalLeadCount, ndlCount: totalNdlCount, dlCount: totalDlCount };
  const tfoot = document.getElementById('spendsTableFoot');
  tfoot.innerHTML = campaigns.length ? `
    <tr class="pivot-total-row">
      <td class="spends-td-check"></td>
      <td class="pin pin-quarter">Total${hasSelection ? ' (selected)' : ''}</td>
      ${cols.map(col => col.isClickableCount
        ? `<td>${fmtInt(clickableTotals[col.key])}</td>`
        : `<td>${col.fmt(kpi[col.key])}${prevKpi ? deltaBadgeHtml(kpi[col.key], prevKpi[col.key]) : ''}</td>`
      ).join('')}
    </tr>
  ` : '';

  // Search-driven re-renders skip the fade-in stagger -- restarting that
  // animation on every keystroke was the "too quick / not pleasing" feel
  // being reported: rows would flash invisible-then-fade on each character
  // instead of just smoothly updating in place.
  if (!skipRowAnim) {
    animateRowsIn(tbody.querySelectorAll('tr'));
    animateBadgesIn(document.querySelectorAll('#spendsTableBody .kpi-delta, #spendsTableFoot .kpi-delta'), 0.15);
  }
}

// Generic -- sets a standalone delta-badge element (a sibling of the value
// it's annotating, not part of its text) from a curr/prev pair. Shared by the
// Spends KPI tiles/table and the Leads tab's date-range comparison.
function setKpiDelta(elId, curr, prev) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.innerHTML = prev === null || prev === undefined ? '' : deltaBadgeHtml(curr, prev);
  el.classList.toggle('hidden', !el.innerHTML);
  if (el.firstElementChild) animateBadgesIn([el.firstElementChild], 0);
}

// Shared by spendsRender (region/channel/load changes, full channel totals)
// and spendsRenderTable (search/selection changes, filtered totals) so the
// KPI tiles always match whatever the table's footer total is showing.
function spendsUpdateKpiTiles(kpi, prevKpi) {
  const config = SPENDS_KPI_CONFIG[spendsIsMessaging() ? 'messaging' : 'paid'];
  config.forEach(tile => {
    document.getElementById(tile.labelId).textContent = tile.label;
    document.getElementById(tile.captionId).textContent = tile.caption;
    document.getElementById(tile.valueId).textContent = tile.fmt(tile.get(kpi));
    setKpiDelta(tile.deltaId, tile.get(kpi), prevKpi ? tile.get(prevKpi) : null);
  });
}

function spendsRender() {
  if (!spendsLastData) return;
  const channelData = spendsGetChannelData(spendsLastData, spendsActiveRegion, spendsActiveChannel);
  spendsRenderRadar(channelData.kpi, channelData.campaigns.length);
  spendsRenderTable();
}

async function spendsLoad() {
  const status = document.getElementById('spendsStatus');
  const refreshTargets = [
    document.querySelector('.radar-widget'),
    document.getElementById('spendsTableWrap'),
  ];
  status.textContent = 'Loading...';
  setRefreshing(true, refreshTargets);
  spendsUpdateCompareToggle();
  try {
    const res = await fetch(`/api/clg-spends?startDate=${spendsStartDate}&endDate=${spendsEndDate}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');

    spendsLastData = data;
    await spendsFetchPrevIfNeeded();
    spendsRender();
    status.textContent = '';
  } catch (err) {
    status.textContent = 'Error: ' + err.message;
  } finally {
    setRefreshing(false, refreshTargets);
  }
}

document.getElementById('spendsCalendarResetBtn').addEventListener('click', spendsResetDateRange);
document.getElementById('spendsCalendarPrevBtnLeft').addEventListener('click', () => {
  spendsCalendarViewDateLeft = new Date(Date.UTC(spendsCalendarViewDateLeft.getUTCFullYear(), spendsCalendarViewDateLeft.getUTCMonth() - 1, 1));
  spendsRenderCalendar();
});
document.getElementById('spendsCalendarNextBtnLeft').addEventListener('click', () => {
  spendsCalendarViewDateLeft = new Date(Date.UTC(spendsCalendarViewDateLeft.getUTCFullYear(), spendsCalendarViewDateLeft.getUTCMonth() + 1, 1));
  spendsRenderCalendar();
});
document.getElementById('spendsCalendarPrevBtnRight').addEventListener('click', () => {
  spendsCalendarViewDateRight = new Date(Date.UTC(spendsCalendarViewDateRight.getUTCFullYear(), spendsCalendarViewDateRight.getUTCMonth() - 1, 1));
  spendsRenderCalendar();
});
document.getElementById('spendsCalendarNextBtnRight').addEventListener('click', () => {
  spendsCalendarViewDateRight = new Date(Date.UTC(spendsCalendarViewDateRight.getUTCFullYear(), spendsCalendarViewDateRight.getUTCMonth() + 1, 1));
  spendsRenderCalendar();
});
document.getElementById('spendsCalendarApplyBtn').addEventListener('click', spendsCommitDateRange);
document.getElementById('spendsCalendarCancelBtn').addEventListener('click', spendsCancelDraftRange);
document.getElementById('spendsCalendarTwoMonths').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-date]');
  if (!btn) return;
  e.stopPropagation(); // see the matching comment on the Leads calendar's listener
  spendsHandleDayClick(btn.dataset.date);
});

document.getElementById('regionSelectSpends').addEventListener('change', (e) => spendsSelectRegion(e.target.value));

document.getElementById('spendsChannelTabs').addEventListener('click', (e) => {
  // The compare-toggle/close buttons also live in this nav but aren't
  // channel tabs -- only react to clicks on an actual data-channel button
  // (LinkedIn/Meta Ads), otherwise this used to blow away spendsActiveChannel
  // and steal the "active" class off the real tabs whenever compare was clicked.
  const btn = e.target.closest('[data-channel]');
  if (!btn) return;
  spendsActiveChannel = btn.dataset.channel;
  document.querySelectorAll('#spendsChannelTabs [data-channel]').forEach(t => t.classList.toggle('active', t === btn));
  pulseScale(btn);
  // MEA only exists for Email/WhatsApp -- bounce back to India rather than
  // showing an empty region if the user had MEA selected and switched to a
  // paid channel. "All Regions" stays valid either way.
  if (!spendsIsMessaging() && spendsActiveRegion === 'MEA') spendsActiveRegion = 'India';
  spendsPopulateRegionSelect();
  spendsClearCampaignSearch();
  spendsClearSelection();
  spendsRender();
});

document.getElementById('spendsGroupToggle').addEventListener('click', spendsToggleGroup);

// Debounced (180ms) -- filtering on every single keystroke felt too abrupt/
// flickery, especially combined with the row fade-in animation restarting
// each time. The clear (x) button still toggles instantly since that's a
// cheap visibility check, not a re-render.
let spendsSearchDebounceTimer = null;
document.getElementById('spendsCampaignSearch').addEventListener('input', (e) => {
  const value = e.target.value;
  document.getElementById('spendsCampaignSearchClear').classList.toggle('hidden', !value);
  clearTimeout(spendsSearchDebounceTimer);
  spendsSearchDebounceTimer = setTimeout(() => {
    spendsSearchQuery = value;
    if (spendsSearchQuery && !spendsGroupExpanded) spendsGroupExpanded = true;
    spendsRenderTable(true);
  }, 180);
});
document.getElementById('spendsCampaignSearchClear').addEventListener('click', () => {
  clearTimeout(spendsSearchDebounceTimer);
  spendsSearchQuery = '';
  const input = document.getElementById('spendsCampaignSearch');
  input.value = '';
  document.getElementById('spendsCampaignSearchClear').classList.add('hidden');
  input.focus();
  spendsRenderTable(true);
});

function spendsDisableCompare() {
  spendsCompareMode = null;
  spendsPrevData = null;
  spendsCustomCompareStart = null;
  spendsCustomCompareEnd = null;
  comparePendingRangeStart = null;
  document.getElementById('spendsCompareToggle').classList.remove('active');
  document.getElementById('spendsCompareCustomBtn').classList.remove('active');
  document.getElementById('spendsCompareCustomLabel').textContent = 'Compare with custom range';
  document.getElementById('spendsCompareClose').classList.add('hidden');
  renderCompareCalendar();
  spendsRender();
}

document.getElementById('spendsCompareToggle').addEventListener('click', async (e) => {
  if (spendsCompareMode === 'auto') {
    spendsDisableCompare();
    return;
  }
  spendsCompareMode = 'auto';
  document.getElementById('spendsCompareToggle').classList.add('active');
  document.getElementById('spendsCompareCustomBtn').classList.remove('active');
  document.getElementById('spendsCompareCustomLabel').textContent = 'Compare with custom range';
  document.getElementById('spendsCompareClose').classList.remove('hidden');
  renderCompareCalendar();
  pulseScale(e.currentTarget);
  const status = document.getElementById('spendsStatus');
  status.textContent = 'Loading comparison...';
  await spendsFetchPrevIfNeeded();
  status.textContent = '';
  spendsRender();
});

document.getElementById('spendsCompareClose').addEventListener('click', (e) => {
  e.stopPropagation();
  spendsDisableCompare();
});

// ---- Custom comparison range -- same two-month single-view calendar and
// mandatory two-click (start, then end) selection as the primary date
// pickers, letting the user compare the selected primary range against ANY
// hand-picked window, not just "the immediately preceding period". ----
let comparePendingRangeStart = null;
let compareDraftStartDate = null;
let compareDraftEndDate = null;
let compareCalendarViewDateLeft = monthStartUTC(spendsEndDate, -1);
let compareCalendarViewDateRight = monthStartUTC(spendsEndDate, 0);

function renderCompareCalendarHeader() {
  const hasDraft = compareDraftStartDate && compareDraftEndDate;
  const hasSelection = spendsCompareMode === 'custom' && spendsCustomCompareStart && spendsCustomCompareEnd;
  const rangePill = document.getElementById('compareCalendarRangePill');
  if (hasDraft) {
    rangePill.textContent = compareDraftStartDate === compareDraftEndDate
      ? DATE_LABEL_FMT.format(new Date(compareDraftEndDate + 'T00:00:00Z'))
      : `${RANGE_DATE_FMT.format(new Date(compareDraftStartDate + 'T00:00:00Z'))} – ${RANGE_DATE_FMT.format(new Date(compareDraftEndDate + 'T00:00:00Z'))}`;
    rangePill.classList.remove('hidden');
  } else if (comparePendingRangeStart) {
    rangePill.textContent = `From ${RANGE_DATE_FMT.format(new Date(comparePendingRangeStart + 'T00:00:00Z'))} — pick end date`;
    rangePill.classList.remove('hidden');
  } else if (hasSelection) {
    rangePill.textContent = spendsCustomCompareStart === spendsCustomCompareEnd
      ? DATE_LABEL_FMT.format(new Date(spendsCustomCompareEnd + 'T00:00:00Z'))
      : `${RANGE_DATE_FMT.format(new Date(spendsCustomCompareStart + 'T00:00:00Z'))} – ${RANGE_DATE_FMT.format(new Date(spendsCustomCompareEnd + 'T00:00:00Z'))}`;
    rangePill.classList.remove('hidden');
  } else {
    rangePill.classList.add('hidden');
  }
  document.getElementById('compareCalendarResetBtn').classList.toggle('hidden', !(comparePendingRangeStart || hasSelection));
  document.getElementById('compareCalendarHelperText').classList.toggle('hidden', !!comparePendingRangeStart || !!hasDraft);
  document.getElementById('compareCalendarApplyRow').classList.toggle('hidden', !hasDraft);
}

function compareUpdateQuickRangeActive() {
  const todayStr = new Date().toISOString().slice(0, 10);
  document.querySelectorAll('#compareQuickRangeRow .quick-range-btn').forEach(btn => {
    const expectedStart = btn.dataset.preset
      ? (btn.dataset.preset === 'fy' ? fiscalYearStartDate() : quarterStartDate())
      : addDaysToDateStr(todayStr, -(parseInt(btn.dataset.days, 10) - 1));
    const isActive = spendsCompareMode === 'custom' && spendsCustomCompareEnd === todayStr && spendsCustomCompareStart === expectedStart;
    btn.classList.toggle('active', isActive);
  });
}

function renderCompareCalendarMonthGrid(viewDate, gridId) {
  const year = viewDate.getUTCFullYear();
  const month = viewDate.getUTCMonth();
  const firstOfMonth = new Date(Date.UTC(year, month, 1));
  const leadingBlanks = (firstOfMonth.getUTCDay() + 6) % 7;
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const todayStr = new Date().toISOString().slice(0, 10);
  const hasDraft = compareDraftStartDate && compareDraftEndDate;
  const hasAppliedSelection = spendsCompareMode === 'custom' && spendsCustomCompareStart && spendsCustomCompareEnd;
  const displayStart = hasDraft ? compareDraftStartDate : spendsCustomCompareStart;
  const displayEnd = hasDraft ? compareDraftEndDate : spendsCustomCompareEnd;
  const hasSelection = hasDraft || hasAppliedSelection;
  const cells = [];
  for (let i = 0; i < leadingBlanks; i++) cells.push('<span class="calendar-day calendar-day-blank"></span>');
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const isFuture = dateStr > todayStr;
    const isToday = dateStr === todayStr;
    const isPending = comparePendingRangeStart === dateStr;
    const isEdge = hasSelection && !comparePendingRangeStart && (dateStr === displayStart || dateStr === displayEnd);
    const isBetween = hasSelection && !comparePendingRangeStart && dateStr > displayStart && dateStr < displayEnd;
    const classes = ['calendar-day'];
    if (isFuture) classes.push('calendar-day-future');
    else if (isPending) classes.push('calendar-day-pending');
    else if (isEdge) classes.push('calendar-day-selected');
    else if (isBetween) classes.push('calendar-day-in-range');
    else if (isToday) classes.push('calendar-day-today');
    const attrs = isFuture ? 'disabled' : `data-date="${dateStr}"`;
    const dot = isToday && !isPending && !isEdge ? '<span class="calendar-day-dot"></span>' : '';
    cells.push(`<button type="button" class="${classes.join(' ')}" ${attrs}>${day}${dot}</button>`);
  }
  document.getElementById(gridId).innerHTML = cells.join('');
}

function renderCompareCalendar() {
  renderCompareCalendarHeader();
  compareUpdateQuickRangeActive();
  document.getElementById('compareCalendarMonthLabelLeft').textContent = CALENDAR_MONTH_FMT.format(compareCalendarViewDateLeft).toUpperCase();
  document.getElementById('compareCalendarMonthLabelRight').textContent = CALENDAR_MONTH_FMT.format(compareCalendarViewDateRight).toUpperCase();
  renderCompareCalendarMonthGrid(compareCalendarViewDateLeft, 'compareCalendarGridLeft');
  renderCompareCalendarMonthGrid(compareCalendarViewDateRight, 'compareCalendarGridRight');
}

async function applyCustomCompareRange(start, end) {
  spendsCustomCompareStart = start;
  spendsCustomCompareEnd = end;
  spendsCompareMode = 'custom';
  compareCalendarViewDateLeft = monthStartUTC(end, -1);
  compareCalendarViewDateRight = monthStartUTC(end, 0);
  renderCompareCalendar();
  document.getElementById('spendsCompareToggle').classList.remove('active');

  const status = document.getElementById('spendsStatus');
  status.textContent = 'Loading comparison...';
  try {
    const res = await fetch(`/api/clg-spends?startDate=${start}&endDate=${end}`);
    const data = await res.json();
    spendsPrevData = res.ok ? data : null;
  } catch (err) {
    spendsPrevData = null;
  }
  status.textContent = '';
  spendsUpdateCompareToggle();
  document.getElementById('spendsCompareClose').classList.remove('hidden');
  spendsRender();
  closeAllDatePopovers();
}

// Picking a start+end day only stages a draft, same as the primary pickers --
// nothing is applied/fetched until Update (compareCommitRange) is clicked.
function handleCompareDayClick(dateStr) {
  if (!comparePendingRangeStart) {
    comparePendingRangeStart = dateStr;
    renderCompareCalendar();
    return;
  }
  compareDraftStartDate = comparePendingRangeStart < dateStr ? comparePendingRangeStart : dateStr;
  compareDraftEndDate = comparePendingRangeStart < dateStr ? dateStr : comparePendingRangeStart;
  comparePendingRangeStart = null;
  renderCompareCalendar();
  pulseScale(document.querySelector('#compareCalendarTwoMonths .calendar-day-selected'));
}

function compareCommitRange() {
  if (compareDraftStartDate && compareDraftEndDate) {
    applyCustomCompareRange(compareDraftStartDate, compareDraftEndDate);
  }
  compareDraftStartDate = null;
  compareDraftEndDate = null;
}

function compareCancelDraftRange() {
  comparePendingRangeStart = null;
  compareDraftStartDate = null;
  compareDraftEndDate = null;
  renderCompareCalendar();
  closeAllDatePopovers();
}

// Quick-range presets/apply are one-click, unambiguous actions -- they still
// commit and close immediately, same as the primary pickers' presets.
function compareApplyQuickRange(days) {
  const todayStr = new Date().toISOString().slice(0, 10);
  comparePendingRangeStart = null;
  compareDraftStartDate = null;
  compareDraftEndDate = null;
  applyCustomCompareRange(addDaysToDateStr(todayStr, -(days - 1)), todayStr);
}

function compareApplyDatePreset(preset) {
  const todayStr = new Date().toISOString().slice(0, 10);
  comparePendingRangeStart = null;
  compareDraftStartDate = null;
  compareDraftEndDate = null;
  applyCustomCompareRange(preset === 'fy' ? fiscalYearStartDate() : quarterStartDate(), todayStr);
}

function compareResetRange() {
  comparePendingRangeStart = null;
  compareDraftStartDate = null;
  compareDraftEndDate = null;
  if (spendsCompareMode === 'custom') { spendsDisableCompare(); return; }
  renderCompareCalendar();
}

document.getElementById('spendsCompareCustomBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const pop = document.getElementById('compareCustomPopover');
  const wasHidden = pop.classList.contains('hidden');
  closeAllDatePopovers();
  if (wasHidden) {
    // Reopening always discards any abandoned draft, same as the primary pickers.
    comparePendingRangeStart = null;
    compareDraftStartDate = null;
    compareDraftEndDate = null;
    if (!(spendsCompareMode === 'custom' && spendsCustomCompareEnd)) {
      compareCalendarViewDateLeft = monthStartUTC(spendsEndDate, -1);
      compareCalendarViewDateRight = monthStartUTC(spendsEndDate, 0);
    }
    renderCompareCalendar();
    pop.classList.remove('hidden');
  }
});
document.getElementById('compareCalendarApplyBtn').addEventListener('click', compareCommitRange);
document.getElementById('compareCalendarCancelBtn').addEventListener('click', compareCancelDraftRange);
document.getElementById('compareCalendarResetBtn').addEventListener('click', compareResetRange);
document.getElementById('compareCalendarPrevBtnLeft').addEventListener('click', () => {
  compareCalendarViewDateLeft = new Date(Date.UTC(compareCalendarViewDateLeft.getUTCFullYear(), compareCalendarViewDateLeft.getUTCMonth() - 1, 1));
  renderCompareCalendar();
});
document.getElementById('compareCalendarNextBtnLeft').addEventListener('click', () => {
  compareCalendarViewDateLeft = new Date(Date.UTC(compareCalendarViewDateLeft.getUTCFullYear(), compareCalendarViewDateLeft.getUTCMonth() + 1, 1));
  renderCompareCalendar();
});
document.getElementById('compareCalendarPrevBtnRight').addEventListener('click', () => {
  compareCalendarViewDateRight = new Date(Date.UTC(compareCalendarViewDateRight.getUTCFullYear(), compareCalendarViewDateRight.getUTCMonth() - 1, 1));
  renderCompareCalendar();
});
document.getElementById('compareCalendarNextBtnRight').addEventListener('click', () => {
  compareCalendarViewDateRight = new Date(Date.UTC(compareCalendarViewDateRight.getUTCFullYear(), compareCalendarViewDateRight.getUTCMonth() + 1, 1));
  renderCompareCalendar();
});
document.getElementById('compareCalendarTwoMonths').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-date]');
  if (!btn) return;
  e.stopPropagation(); // see the matching comment on the Leads calendar's listener
  handleCompareDayClick(btn.dataset.date);
});
document.getElementById('compareQuickRangeRow').addEventListener('click', (e) => {
  const btn = e.target.closest('.quick-range-btn');
  if (!btn) return;
  pulseScale(btn);
  if (btn.dataset.preset) compareApplyDatePreset(btn.dataset.preset);
  else compareApplyQuickRange(parseInt(btn.dataset.days, 10));
});

// ---- Quick-range presets (7/14/30/60/90 days ending today), matching the
// canned windows LinkedIn/Meta Ads' own dashboards offer, as an alternative
// to manually picking two dates on the calendar. ----
function spendsUpdateQuickRangeActive() {
  const todayStr = new Date().toISOString().slice(0, 10);
  document.querySelectorAll('#spendsQuickRangeRow .quick-range-btn').forEach(btn => {
    const expectedStart = btn.dataset.preset
      ? (btn.dataset.preset === 'fy' ? fiscalYearStartDate() : quarterStartDate())
      : addDaysToDateStr(todayStr, -(parseInt(btn.dataset.days, 10) - 1));
    const isActive = spendsHasExplicitSelection && spendsEndDate === todayStr && spendsStartDate === expectedStart;
    btn.classList.toggle('active', isActive);
  });
}

function spendsApplyQuickRange(days) {
  const todayStr = new Date().toISOString().slice(0, 10);
  spendsPendingRangeStart = null;
  spendsDraftStartDate = null;
  spendsDraftEndDate = null;
  spendsEndDate = todayStr;
  spendsStartDate = addDaysToDateStr(todayStr, -(days - 1));
  spendsHasExplicitSelection = true;
  spendsCalendarViewDateLeft = monthStartUTC(spendsEndDate, -1);
  spendsCalendarViewDateRight = monthStartUTC(spendsEndDate, 0);
  spendsRenderCalendar();
  spendsLoad();
  closeAllDatePopovers();
}

function spendsApplyDatePreset(preset) {
  const todayStr = new Date().toISOString().slice(0, 10);
  spendsPendingRangeStart = null;
  spendsDraftStartDate = null;
  spendsDraftEndDate = null;
  spendsEndDate = todayStr;
  spendsStartDate = preset === 'fy' ? fiscalYearStartDate() : quarterStartDate();
  spendsHasExplicitSelection = true;
  spendsCalendarViewDateLeft = monthStartUTC(spendsEndDate, -1);
  spendsCalendarViewDateRight = monthStartUTC(spendsEndDate, 0);
  spendsRenderCalendar();
  spendsLoad();
  closeAllDatePopovers();
}

document.getElementById('spendsQuickRangeRow').addEventListener('click', (e) => {
  const btn = e.target.closest('.quick-range-btn');
  if (!btn) return;
  pulseScale(btn);
  if (btn.dataset.preset) spendsApplyDatePreset(btn.dataset.preset);
  else spendsApplyQuickRange(parseInt(btn.dataset.days, 10));
});

populateRegionSelectLeads();
spendsPopulateRegionSelect();
renderCalendar();
load();
