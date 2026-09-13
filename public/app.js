const fmtInt = (n) => Math.round(n).toLocaleString('en-IN');
const fmtDec = (n) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Categorical palette (fixed order, never cycled/reassigned by rank) --
// matches the dataviz reference palette, validated for CVD-safe adjacent pairs.
const PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];

// LATAM has no Salesforce filter/sync built yet -- the API already resolves
// it to a clean all-zero region (see REGION_SHEETS in api/clg-regions.js), so
// it's safe to list here now and wire up real data later.
const REGIONS = [
  { key: 'India', color: PALETTE[0] },
  { key: 'SEA', color: PALETTE[1] },
  { key: 'EU', color: PALETTE[2] },
  { key: 'LATAM', color: PALETTE[3] },
];

let activeRegion = 'India';
let activeStage = 'lead';
let lastData = null;
let viewingSpends = false;

// Default view window (also what Reset returns to) -- Jun 1 to Aug 30.
const DEFAULT_START_DATE = '2026-06-01';
const DEFAULT_END_DATE = '2026-08-30';
let currentStartDate = DEFAULT_START_DATE;
let currentEndDate = DEFAULT_END_DATE;

// Spends tab default -- Apr 1 to Sep 10, independent of the Leads dashboard's
// own default above (deliberately different date per the user's request).
const SPENDS_DEFAULT_START_DATE = '2026-04-01';
const SPENDS_DEFAULT_END_DATE = '2026-09-10';

const METRIC_FMT = { leadAge: fmtDec, ndl: fmtInt, count: fmtInt };

// Theme toggle -- dark (default) / light (Netcore orange+white). Persisted
// per-browser via localStorage; falls back to dark on first visit rather
// than following the OS preference, matching the earlier decision that this
// dashboard's chrome shouldn't silently flip on the viewer's system setting.
const THEME_STORAGE_KEY = 'clg-dashboard-theme';
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const icon = document.getElementById('themeToggleIcon');
  const label = document.getElementById('themeToggleLabel');
  if (theme === 'light') {
    if (icon) icon.textContent = '\u{1F319}'; // moon -- click to go dark
    if (label) label.textContent = 'Dark';
  } else {
    if (icon) icon.textContent = '\u{2600}\u{FE0F}'; // sun -- click to go light
    if (label) label.textContent = 'Light';
  }
}
function initTheme() {
  const saved = localStorage.getItem(THEME_STORAGE_KEY);
  applyTheme(saved === 'light' ? 'light' : 'dark');
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

function renderChart(regionData) {
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
              <span class="bar-value">${fmtInt(count)}</span>
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
function metricRow({ quarterCell, subSourceCell, metric, cells, statusColumns, extraClass = '', revealColumns = null }) {
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
        // The MRR pseudo-column (Leads tab only) is a dollar amount, not a
        // lead count -- it only shows on the bold Leads row, formatted as
        // currency, and is never clickable (no per-lead breakdown for it).
        if (col && col.isMrr) {
          const val = metric.bold ? fmtCurrency(isRevealed(col) ? (cell.mrr || 0) : 0) : '';
          return `<td class="pivot-cell${metric.bold ? ' pivot-cell-count' : ''} pivot-cell-mrr">${val}</td>`;
        }
        const clickable = metric.bold && cell.records && cell.records.length > 0;
        const cls = `pivot-cell${metric.bold ? ' pivot-cell-count' : ''}${clickable ? ' pivot-cell-clickable' : ''}`;
        const statusLabel = col ? col.label : '';
        const dataAttrs = clickable
          ? ` data-records="${encodeURIComponent(JSON.stringify(cell.records))}" data-status-label="${escapeHtml(statusLabel)}"`
          : '';
        return `<td class="${cls}"${dataAttrs}>${isRevealed(col) ? fmt(cell[metric.key]) : fmt(0)}</td>`;
      }).join('')}
    </tr>
  `;
}

function renderPivotBody(pivot, revealColumns = null) {
  if (!pivot.rows.length) return '<tr><td colspan="99" class="empty">No matching leads in this range.</td></tr>';
  const metrics = pivot.metrics;

  const quarterRowCounts = new Map();
  pivot.rows.forEach(r => quarterRowCounts.set(r.quarter, (quarterRowCounts.get(r.quarter) || 0) + metrics.length));
  const seenQuarter = new Set();

  return pivot.rows.map(row => {
    const isFirstOfQuarter = !seenQuarter.has(row.quarter);
    seenQuarter.add(row.quarter);

    return metrics.map((metric, i) => {
      const quarterCell = isFirstOfQuarter && i === 0
        ? `<td class="pin pin-quarter" rowspan="${quarterRowCounts.get(row.quarter)}">${escapeHtml(row.quarter)}</td>`
        : '';
      const subSourceCell = i === 0
        ? `<td class="pin pin-subsource" rowspan="${metrics.length}" title="${escapeHtml(row.subSource)}">${escapeHtml(row.subSource)}</td>`
        : '';
      return metricRow({ quarterCell, subSourceCell, metric, cells: row.cells, statusColumns: pivot.statusColumns, revealColumns });
    }).join('');
  }).join('');
}

function renderPivotFoot(pivot, revealColumns = null) {
  const metrics = pivot.metrics;
  return metrics.map((metric, i) => {
    const quarterCell = i === 0 ? `<td class="pin pin-quarter" rowspan="${metrics.length}">Total</td>` : '';
    const subSourceCell = i === 0 ? `<td class="pin pin-subsource" rowspan="${metrics.length}"></td>` : '';
    return metricRow({ quarterCell, subSourceCell, metric, cells: pivot.columnTotals, statusColumns: pivot.statusColumns, extraClass: 'pivot-total-row', revealColumns });
  }).join('');
}

// Funnel View (the only stage renderRegion is called for now that IQL/MQL/
// SQL live under the Trends tab instead) -- table only, no KPI tiles (an
// exact duplicate of the top overview bento boxes) and no chart (moved to
// Trends alongside IQL/MQL/SQL's charts).
function renderRegion(region, stage, data) {
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
  node.querySelector('.pivot-table tbody').innerHTML = renderPivotBody(data.pivot, revealColumns);
  node.querySelector('.pivot-table tfoot').innerHTML = data.pivot.rows.length ? renderPivotFoot(data.pivot, revealColumns) : '';

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
// renderLegend() exactly as the old per-stage tabs did; only the title logic
// differs per stage's own chartMode (IQL/MQL are 'simple' -- one bar per
// quarter, no legend; Leads/SQL are 'breakdown' with a two-level axis title).
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

    const title = key === 'sql'
      ? 'Opportunity Source &gt; Opportunity Sub Source'
      : (data.chartMode === 'breakdown' ? `${escapeHtml(data.dateAxisLabel)} &gt; ${escapeHtml(data.pivot.innerLabel)}` : escapeHtml(data.dateAxisLabel));

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
    `;
    wrap.appendChild(section);
  }
  return wrap;
}

function render() {
  if (!lastData) return;
  const app = document.getElementById('app');
  app.innerHTML = '';
  if (activeStage === 'trends') {
    app.appendChild(renderTrends(activeRegion));
    animateViewIn(app);
    return;
  }
  const data = lastData.regions[activeRegion][activeStage];
  app.appendChild(renderRegion(activeRegion, activeStage, data));
  animateViewIn(app);
}

// ---- Overview boxes: Leads / Total NDL / Leads+NDL for the active region,
// always read off that region's Leads-stage totals regardless of which
// stage tab is currently open. ----
function renderOverview() {
  if (!lastData) return;
  const lead = lastData.regions[activeRegion].lead;
  document.getElementById('overviewLeads').textContent = fmtInt(lead.totalRecords);
  document.getElementById('overviewNdl').textContent = fmtInt(lead.totalNDL);
  document.getElementById('overviewSum').textContent = fmtInt(lead.totalRecords + lead.totalNDL);
}

// ---- Region filter: donut (equal-share wedges -- a filter, not a volume
// chart) + legend. ----
function renderDonut() {
  const svg = document.getElementById('regionDonut');

  const r = 15.915; // circumference ~= 100, so percentages map directly to dasharray
  const share = 100 / REGIONS.length;
  const gap = 1.6; // visible thin divider between adjacent wedges
  const segLen = share - gap;

  let offset = 0;
  const circles = REGIONS.map(region => {
    const isActive = activeRegion === region.key;
    const cls = `donut-seg${isActive ? ' donut-seg-active' : ' donut-seg-dim'}`;
    const strokeWidth = isActive ? 8 : 6;
    const circle = `<circle class="${cls}" cx="21" cy="21" r="${r}" fill="none"
      stroke="${region.color}" stroke-width="${strokeWidth}" style="color:${region.color}"
      stroke-dasharray="${segLen} ${100 - segLen}" stroke-dashoffset="${-offset}" data-region="${region.key}" />`;
    offset += share;
    return circle;
  });
  svg.innerHTML = circles.join('');
  document.getElementById('donutCenterLabel').textContent = activeRegion;
}

function renderRegionLegend() {
  const legend = document.getElementById('regionLegend');
  legend.innerHTML = REGIONS.map(region => `
    <li data-region="${region.key}" class="${activeRegion === region.key ? 'active' : ''}">
      <span class="swatch" style="background:${region.color}"></span>
      ${escapeHtml(region.key)}
    </li>
  `).join('');
}

// ---- Radar widget: purely illustrative "live tracker" -- blip count scales
// loosely with the active region's lead volume, positions are fixed (12
// deterministic polar slots) so the widget doesn't jitter on every reload. ----
const RADAR_CX = 100, RADAR_CY = 100;
const RADAR_BLIP_SLOTS = [
  { deg: 18,  r: 38 }, { deg: 72,  r: 60 }, { deg: 128, r: 30 }, { deg: 165, r: 70 },
  { deg: 210, r: 48 }, { deg: 252, r: 74 }, { deg: 293, r: 36 }, { deg: 328, r: 56 },
  { deg: 350, r: 24 }, { deg: 95,  r: 45 }, { deg: 145, r: 62 }, { deg: 185, r: 28 },
];
function radarToXY(deg, r) {
  const rad = (deg - 90) * Math.PI / 180;
  return [RADAR_CX + r * Math.cos(rad), RADAR_CY + r * Math.sin(rad)];
}

function renderRadar() {
  const lead = lastData ? lastData.regions[activeRegion].lead : { totalRecords: 0, totalNDL: 0 };
  const count = lead.totalRecords;
  const blipCount = Math.max(1, Math.min(RADAR_BLIP_SLOTS.length, Math.ceil(count / 20)));
  const g = document.getElementById('radarBlips');
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

  document.getElementById('radarTracked').textContent = fmtInt(lead.totalRecords);
  document.getElementById('radarNdl').textContent = fmtInt(lead.totalNDL);
  document.getElementById('radarSum').textContent = fmtInt(lead.totalRecords + lead.totalNDL);
  document.getElementById('radarWindow').textContent = `▶ SCAN WINDOW: ${currentStartDate} → ${currentEndDate}`;
}

// Cycles the radar's status line through a fixed set of flavor-text messages.
const RADAR_MESSAGES = [
  'SCANNING SECTOR...', 'LEAD DETECTED', 'ANALYSING FUNNEL...', 'SIGNAL ACQUIRED',
  'SCANNING SECTOR...', 'TRACKING VOLUME...', 'DATA SYNCED',
];
let radarMsgIdx = 0;
setInterval(() => {
  radarMsgIdx = (radarMsgIdx + 1) % RADAR_MESSAGES.length;
  const el = document.getElementById('radarMessage');
  if (el) el.textContent = `▶ ${RADAR_MESSAGES[radarMsgIdx]}`;
}, 2200);

// ---- Date-range control: an always-visible calendar card (not a dropdown),
// styled after the reference MonthCalendar component. Two selection modes:
//   - "single" (default): clicking a day filters everything to that one day.
//   - "range" (toggled via the Date Range button): first click picks a start
//     day, then the user can page to a different month and click an end day;
//     the two are normalized into currentStartDate/currentEndDate.
// hasExplicitSelection tracks whether the user has actually picked a day (vs.
// still sitting on the FY-to-date default), so the default's wide span
// doesn't paint every visible day as "in range". Future dates are disabled --
// this dashboard only ever has data up to today. ----
const DATE_LABEL_FMT = new Intl.DateTimeFormat('en-US', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const RANGE_DATE_FMT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const CALENDAR_MONTH_FMT = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

let selectionMode = 'single'; // 'single' | 'range'
let pendingRangeStart = null;
let hasExplicitSelection = false;
// The month currently shown in the calendar -- defaults to the selected end
// date's month but can be paged independently via prev/next.
let calendarViewDate = new Date(currentEndDate + 'T00:00:00Z');

function renderCalendarHeader() {
  document.getElementById('calendarMonthLabel').textContent = CALENDAR_MONTH_FMT.format(calendarViewDate).toUpperCase();
  document.getElementById('dateRangeBtn').classList.toggle('active', selectionMode === 'range');

  const hasRange = hasExplicitSelection && currentStartDate !== currentEndDate;

  const rangePill = document.getElementById('calendarRangePill');
  if (hasRange) {
    rangePill.textContent = `${RANGE_DATE_FMT.format(new Date(currentStartDate + 'T00:00:00Z'))} – ${RANGE_DATE_FMT.format(new Date(currentEndDate + 'T00:00:00Z'))}`;
    rangePill.classList.remove('hidden');
  } else if (pendingRangeStart) {
    rangePill.textContent = `From ${RANGE_DATE_FMT.format(new Date(pendingRangeStart + 'T00:00:00Z'))} — pick end date`;
    rangePill.classList.remove('hidden');
  } else {
    rangePill.classList.add('hidden');
  }

  document.getElementById('calendarResetBtn').classList.toggle('hidden', !(selectionMode === 'range' || hasRange));

  const singleLabel = document.getElementById('dateRangeValue');
  if (selectionMode === 'single' && !hasRange && hasExplicitSelection) {
    singleLabel.textContent = DATE_LABEL_FMT.format(new Date(currentEndDate + 'T00:00:00Z'));
    singleLabel.classList.remove('hidden');
  } else {
    singleLabel.classList.add('hidden');
  }

  document.getElementById('calendarHelperText').classList.toggle('hidden', !(selectionMode === 'range' && !pendingRangeStart));
}

function renderCalendar() {
  renderCalendarHeader();
  updateQuickRangeActive();

  const year = calendarViewDate.getUTCFullYear();
  const month = calendarViewDate.getUTCMonth();
  const firstOfMonth = new Date(Date.UTC(year, month, 1));
  // Grid starts on Monday -- getUTCDay() is 0=Sun..6=Sat, shift so Mon=0.
  const leadingBlanks = (firstOfMonth.getUTCDay() + 6) % 7;
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

  const todayStr = new Date().toISOString().slice(0, 10);
  const hasRange = hasExplicitSelection && currentStartDate !== currentEndDate;
  const cells = [];
  for (let i = 0; i < leadingBlanks; i++) cells.push('<span class="calendar-day calendar-day-blank"></span>');
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const isFuture = dateStr > todayStr;
    const isToday = dateStr === todayStr;
    const isSingleSelected = selectionMode === 'single' && hasExplicitSelection && !hasRange && dateStr === currentEndDate;
    const isPending = selectionMode === 'range' && pendingRangeStart === dateStr;
    const isEdge = hasRange && (dateStr === currentStartDate || dateStr === currentEndDate);
    const isBetween = hasRange && dateStr > currentStartDate && dateStr < currentEndDate;

    const classes = ['calendar-day'];
    if (isFuture) classes.push('calendar-day-future');
    else if (isPending) classes.push('calendar-day-pending');
    else if (isEdge || isSingleSelected) classes.push('calendar-day-selected');
    else if (isBetween) classes.push('calendar-day-in-range');
    else if (isToday) classes.push('calendar-day-today');

    const attrs = isFuture ? 'disabled' : `data-date="${dateStr}"`;
    const dot = isToday && !isPending && !isEdge && !isSingleSelected ? '<span class="calendar-day-dot"></span>' : '';
    cells.push(`<button type="button" class="${classes.join(' ')}" ${attrs}>${day}${dot}</button>`);
  }
  document.getElementById('calendarGrid').innerHTML = cells.join('');
}

function handleDayClick(dateStr) {
  if (selectionMode === 'range') {
    if (!pendingRangeStart) {
      pendingRangeStart = dateStr;
      renderCalendar();
      return;
    }
    currentStartDate = pendingRangeStart < dateStr ? pendingRangeStart : dateStr;
    currentEndDate = pendingRangeStart < dateStr ? dateStr : pendingRangeStart;
    pendingRangeStart = null;
  } else {
    currentStartDate = dateStr;
    currentEndDate = dateStr;
  }
  hasExplicitSelection = true;
  renderCalendar();
  pulseScale(document.querySelector('#calendarGrid .calendar-day-selected, #calendarGrid .calendar-day-pending'));
  load();
}

function resetDateRange() {
  selectionMode = 'single';
  pendingRangeStart = null;
  hasExplicitSelection = false;
  currentStartDate = DEFAULT_START_DATE;
  currentEndDate = DEFAULT_END_DATE;
  calendarViewDate = new Date(currentEndDate + 'T00:00:00Z');
  renderCalendar();
  load();
}

// ---- Quick-range presets (7/14/30/60/90 days ending today) -- same idea as
// the Spends tab's, mirrored here for the Leads dashboard's own calendar. ----
function updateQuickRangeActive() {
  const todayStr = new Date().toISOString().slice(0, 10);
  document.querySelectorAll('#quickRangeRow .quick-range-btn').forEach(btn => {
    const days = parseInt(btn.dataset.days, 10);
    const expectedStart = addDaysToDateStr(todayStr, -(days - 1));
    const isActive = hasExplicitSelection && currentEndDate === todayStr && currentStartDate === expectedStart;
    btn.classList.toggle('active', isActive);
  });
}

function applyQuickRange(days) {
  const todayStr = new Date().toISOString().slice(0, 10);
  selectionMode = 'single';
  pendingRangeStart = null;
  currentEndDate = todayStr;
  currentStartDate = addDaysToDateStr(todayStr, -(days - 1));
  hasExplicitSelection = true;
  calendarViewDate = new Date(currentEndDate + 'T00:00:00Z');
  renderCalendar();
  load();
}

function showSpends(show) {
  viewingSpends = show;
  const spendsEl = document.getElementById('spendsView');
  const leadsEl = document.getElementById('leadsView');
  spendsEl.classList.toggle('hidden', !show);
  leadsEl.classList.toggle('hidden', show);
  animateViewIn(show ? spendsEl : leadsEl, 18);
  smoothScrollTop();
  if (show) {
    spendsRenderCalendar();
    spendsLoad();
  }
}

async function load() {
  const status = document.getElementById('status');

  status.textContent = 'Loading...';
  try {
    const res = await fetch(`/api/clg-regions?startDate=${currentStartDate}&endDate=${currentEndDate}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');

    lastData = data;
    render();
    renderOverview();
    renderDonut();
    renderRegionLegend();
    renderRadar();
    document.getElementById('lastUpdated').textContent = 'Updated ' + new Date(data.lastUpdated).toLocaleString();
    status.textContent = '';
  } catch (err) {
    status.textContent = 'Error: ' + err.message;
  }
}

function selectRegion(regionKey) {
  activeRegion = regionKey;
  showSpends(false);
  render();
  renderOverview();
  renderDonut();
  renderRegionLegend();
  renderRadar();
  smoothScrollTop();
}

document.getElementById('dateRangeBtn').addEventListener('click', () => {
  selectionMode = selectionMode === 'range' ? 'single' : 'range';
  pendingRangeStart = null;
  renderCalendar();
});
document.getElementById('calendarResetBtn').addEventListener('click', resetDateRange);
document.getElementById('calendarPrevBtn').addEventListener('click', () => {
  calendarViewDate = new Date(Date.UTC(calendarViewDate.getUTCFullYear(), calendarViewDate.getUTCMonth() - 1, 1));
  renderCalendar();
});
document.getElementById('calendarNextBtn').addEventListener('click', () => {
  calendarViewDate = new Date(Date.UTC(calendarViewDate.getUTCFullYear(), calendarViewDate.getUTCMonth() + 1, 1));
  renderCalendar();
});
document.getElementById('calendarGrid').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-date]');
  if (!btn) return;
  handleDayClick(btn.dataset.date);
});
document.getElementById('quickRangeRow').addEventListener('click', (e) => {
  const btn = e.target.closest('.quick-range-btn');
  if (!btn) return;
  pulseScale(btn);
  applyQuickRange(parseInt(btn.dataset.days, 10));
});

document.getElementById('regionDonut').addEventListener('click', (e) => {
  const seg = e.target.closest('[data-region]');
  if (!seg) return;
  selectRegion(seg.dataset.region);
});

document.getElementById('regionLegend').addEventListener('click', (e) => {
  const item = e.target.closest('[data-region]');
  if (!item) return;
  selectRegion(item.dataset.region);
});

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

function openLeadModal(records, statusLabel) {
  leadModalTitle.textContent = statusLabel;
  modalCountBadge.textContent = `${records.length} lead${records.length === 1 ? '' : 's'}`;
  const baseUrl = (lastData && lastData.sfRecordBaseUrl) || '';
  modalTimeline.innerHTML = records.map(r => `
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
  `).join('');
  modalFooter.textContent = `Showing ${records.length} lead${records.length === 1 ? '' : 's'} in this cell`;
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

document.getElementById('app').addEventListener('click', (e) => {
  const cell = e.target.closest('.pivot-cell-clickable');
  if (!cell) return;
  const records = JSON.parse(decodeURIComponent(cell.dataset.records));
  const statusLabel = cell.dataset.statusLabel || '';
  openLeadModal(records, statusLabel);
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

let spendsSelectionMode = 'single';
let spendsPendingRangeStart = null;
let spendsHasExplicitSelection = false;
let spendsStartDate = SPENDS_DEFAULT_START_DATE;
let spendsEndDate = SPENDS_DEFAULT_END_DATE;
let spendsCalendarViewDate = new Date(spendsEndDate + 'T00:00:00Z');

// ---- Period-over-period comparison -- only offered for a handful of round
// window lengths (7 days / 2 weeks / 1 month / 3 months); anything else (an
// arbitrary custom range) gets no compare toggle at all, since "previous
// period" is ambiguous otherwise. ----
let spendsComparePeriod = null; // detected {days, label} for the current range, or null
let spendsCompareEnabled = false;
let spendsPrevData = null; // full /api/clg-spends response for the immediately-preceding period of the same length

function spendsDetectPeriod(startDate, endDate) {
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
  if (!spendsCompareEnabled || !spendsPrevData) return null;
  return spendsPrevData.regions[spendsActiveRegion][spendsActiveChannel];
}

function spendsUpdateCompareToggle() {
  spendsComparePeriod = spendsDetectPeriod(spendsStartDate, spendsEndDate);
  const btn = document.getElementById('spendsCompareToggle');
  const closeBtn = document.getElementById('spendsCompareClose');
  if (!spendsComparePeriod) {
    btn.classList.add('hidden');
    closeBtn.classList.add('hidden');
    spendsCompareEnabled = false;
    spendsPrevData = null;
    return;
  }
  btn.textContent = `Compare with previous ${spendsComparePeriod.label}`;
  btn.classList.remove('hidden');
  btn.classList.toggle('active', spendsCompareEnabled);
  closeBtn.classList.toggle('hidden', !spendsCompareEnabled);
}

async function spendsFetchPrevIfNeeded() {
  if (!spendsCompareEnabled || !spendsComparePeriod) { spendsPrevData = null; return; }
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

function spendsUpdateRangeLabel() {
  const label = document.getElementById('spendsDateRangeValue');
  const hasRange = spendsHasExplicitSelection && spendsStartDate !== spendsEndDate;
  if (!spendsHasExplicitSelection || !hasRange) {
    label.textContent = DATE_LABEL_FMT.format(new Date(spendsEndDate + 'T00:00:00Z'));
  } else {
    label.textContent = `${RANGE_DATE_FMT.format(new Date(spendsStartDate + 'T00:00:00Z'))} – ${RANGE_DATE_FMT.format(new Date(spendsEndDate + 'T00:00:00Z'))}`;
  }
}

function spendsRenderCalendarHeader() {
  document.getElementById('spendsCalendarMonthLabel').textContent = CALENDAR_MONTH_FMT.format(spendsCalendarViewDate).toUpperCase();
  document.getElementById('spendsDateRangeBtn').classList.toggle('active', spendsSelectionMode === 'range');

  const hasRange = spendsHasExplicitSelection && spendsStartDate !== spendsEndDate;
  const rangePill = document.getElementById('spendsCalendarRangePill');
  if (hasRange) {
    rangePill.textContent = `${RANGE_DATE_FMT.format(new Date(spendsStartDate + 'T00:00:00Z'))} – ${RANGE_DATE_FMT.format(new Date(spendsEndDate + 'T00:00:00Z'))}`;
    rangePill.classList.remove('hidden');
  } else if (spendsPendingRangeStart) {
    rangePill.textContent = `From ${RANGE_DATE_FMT.format(new Date(spendsPendingRangeStart + 'T00:00:00Z'))} — pick end date`;
    rangePill.classList.remove('hidden');
  } else {
    rangePill.classList.add('hidden');
  }

  document.getElementById('spendsCalendarResetBtn').classList.toggle('hidden', !(spendsSelectionMode === 'range' || hasRange));

  const singleLabel = document.getElementById('spendsDateRangeValue');
  if (spendsSelectionMode === 'single' && !hasRange && spendsHasExplicitSelection) {
    singleLabel.textContent = DATE_LABEL_FMT.format(new Date(spendsEndDate + 'T00:00:00Z'));
    singleLabel.classList.remove('hidden');
  } else {
    singleLabel.classList.add('hidden');
  }

  document.getElementById('spendsCalendarHelperText').classList.toggle('hidden', !(spendsSelectionMode === 'range' && !spendsPendingRangeStart));
}

function spendsRenderCalendar() {
  spendsRenderCalendarHeader();
  spendsUpdateQuickRangeActive();

  const year = spendsCalendarViewDate.getUTCFullYear();
  const month = spendsCalendarViewDate.getUTCMonth();
  const firstOfMonth = new Date(Date.UTC(year, month, 1));
  const leadingBlanks = (firstOfMonth.getUTCDay() + 6) % 7;
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

  const todayStr = new Date().toISOString().slice(0, 10);
  const hasRange = spendsHasExplicitSelection && spendsStartDate !== spendsEndDate;
  const cells = [];
  for (let i = 0; i < leadingBlanks; i++) cells.push('<span class="calendar-day calendar-day-blank"></span>');
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const isFuture = dateStr > todayStr;
    const isToday = dateStr === todayStr;
    const isSingleSelected = spendsSelectionMode === 'single' && spendsHasExplicitSelection && !hasRange && dateStr === spendsEndDate;
    const isPending = spendsSelectionMode === 'range' && spendsPendingRangeStart === dateStr;
    const isEdge = hasRange && (dateStr === spendsStartDate || dateStr === spendsEndDate);
    const isBetween = hasRange && dateStr > spendsStartDate && dateStr < spendsEndDate;

    const classes = ['calendar-day'];
    if (isFuture) classes.push('calendar-day-future');
    else if (isPending) classes.push('calendar-day-pending');
    else if (isEdge || isSingleSelected) classes.push('calendar-day-selected');
    else if (isBetween) classes.push('calendar-day-in-range');
    else if (isToday) classes.push('calendar-day-today');

    const attrs = isFuture ? 'disabled' : `data-date="${dateStr}"`;
    const dot = isToday && !isPending && !isEdge && !isSingleSelected ? '<span class="calendar-day-dot"></span>' : '';
    cells.push(`<button type="button" class="${classes.join(' ')}" ${attrs}>${day}${dot}</button>`);
  }
  document.getElementById('spendsCalendarGrid').innerHTML = cells.join('');
}

function spendsHandleDayClick(dateStr) {
  if (spendsSelectionMode === 'range') {
    if (!spendsPendingRangeStart) {
      spendsPendingRangeStart = dateStr;
      spendsRenderCalendar();
      return;
    }
    spendsStartDate = spendsPendingRangeStart < dateStr ? spendsPendingRangeStart : dateStr;
    spendsEndDate = spendsPendingRangeStart < dateStr ? dateStr : spendsPendingRangeStart;
    spendsPendingRangeStart = null;
  } else {
    spendsStartDate = dateStr;
    spendsEndDate = dateStr;
  }
  spendsHasExplicitSelection = true;
  spendsRenderCalendar();
  pulseScale(document.querySelector('#spendsCalendarGrid .calendar-day-selected, #spendsCalendarGrid .calendar-day-pending'));
  spendsLoad();
}

function spendsResetDateRange() {
  spendsSelectionMode = 'single';
  spendsPendingRangeStart = null;
  spendsHasExplicitSelection = false;
  spendsStartDate = SPENDS_DEFAULT_START_DATE;
  spendsEndDate = SPENDS_DEFAULT_END_DATE;
  spendsCalendarViewDate = new Date(spendsEndDate + 'T00:00:00Z');
  spendsRenderCalendar();
  spendsLoad();
}

function spendsRenderDonut() {
  const svg = document.getElementById('spendsRegionDonut');
  const r = 15.915;
  const share = 100 / REGIONS.length;
  const gap = 1.6;
  const segLen = share - gap;

  let offset = 0;
  const circles = REGIONS.map(region => {
    const isActive = spendsActiveRegion === region.key;
    const cls = `donut-seg${isActive ? ' donut-seg-active' : ' donut-seg-dim'}`;
    const strokeWidth = isActive ? 8 : 6;
    const circle = `<circle class="${cls}" cx="21" cy="21" r="${r}" fill="none"
      stroke="${region.color}" stroke-width="${strokeWidth}" style="color:${region.color}"
      stroke-dasharray="${segLen} ${100 - segLen}" stroke-dashoffset="${-offset}" data-region="${region.key}" />`;
    offset += share;
    return circle;
  });
  svg.innerHTML = circles.join('');
  document.getElementById('spendsDonutCenterLabel').textContent = spendsActiveRegion;
}

function spendsRenderRegionLegend() {
  const legend = document.getElementById('spendsRegionLegend');
  legend.innerHTML = REGIONS.map(region => `
    <li data-region="${region.key}" class="${spendsActiveRegion === region.key ? 'active' : ''}">
      <span class="swatch" style="background:${region.color}"></span>
      ${escapeHtml(region.key)}
    </li>
  `).join('');
}

function spendsSelectRegion(regionKey) {
  spendsActiveRegion = regionKey;
  spendsRenderDonut();
  spendsRenderRegionLegend();
  spendsRender();
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

  document.getElementById('spendsRadarCampaigns').textContent = fmtInt(campaignCount);
  document.getElementById('spendsRadarImpressions').textContent = fmtInt(kpi.impressions);
  document.getElementById('spendsRadarCpc').textContent = fmtCurrency(kpi.cpc);
  document.getElementById('spendsRadarWindow').textContent = `▶ SCAN WINDOW: ${spendsStartDate} → ${spendsEndDate}`;
}

function spendsToggleGroup() {
  spendsGroupExpanded = !spendsGroupExpanded;
  spendsRenderTable();
}

function spendsRenderTable() {
  if (!spendsLastData) return;
  const channelData = spendsLastData.regions[spendsActiveRegion][spendsActiveChannel];
  const campaigns = channelData.campaigns;
  const kpi = channelData.kpi;
  const prevChannelData = spendsGetPrevChannelData();
  const prevKpi = prevChannelData ? prevChannelData.kpi : null;
  const prevByName = new Map((prevChannelData ? prevChannelData.campaigns : []).map(c => [c.name, c]));
  // Only render a delta at all once comparison is on for this range -- an
  // undefined prev value (vs. a real 0) tells deltaBadgeHtml to render nothing.
  const prevFor = (name, key) => prevChannelData ? ((prevByName.get(name) || { [key]: 0 })[key]) : undefined;

  document.getElementById('spendsGroupTitle').textContent = `${spendsActiveRegion} Campaigns`;
  document.getElementById('spendsGroupMeta').textContent = `${campaigns.length} campaign${campaigns.length === 1 ? '' : 's'} · ${fmtCurrency(kpi.spend)}`;
  document.querySelector('.spends-group-arrow').innerHTML = spendsGroupExpanded ? '&#9662;' : '&#9656;';
  document.getElementById('spendsTableWrap').classList.toggle('hidden', !spendsGroupExpanded);

  const tbody = document.getElementById('spendsTableBody');
  tbody.innerHTML = campaigns.length
    ? campaigns.map(c => `
      <tr>
        <td class="pin pin-quarter spends-td-name" title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</td>
        <td>${fmtCurrency(c.spend)}${deltaBadgeHtml(c.spend, prevFor(c.name, 'spend'))}</td>
        <td>${fmtInt(c.clicks)}${deltaBadgeHtml(c.clicks, prevFor(c.name, 'clicks'))}</td>
        <td>${fmtInt(c.impressions)}${deltaBadgeHtml(c.impressions, prevFor(c.name, 'impressions'))}</td>
        <td>${fmtDec(c.ctr)}%${deltaBadgeHtml(c.ctr, prevFor(c.name, 'ctr'))}</td>
        <td>${fmtCurrency(c.cpm)}${deltaBadgeHtml(c.cpm, prevFor(c.name, 'cpm'))}</td>
        <td>${fmtCurrency(c.cpc)}${deltaBadgeHtml(c.cpc, prevFor(c.name, 'cpc'))}</td>
      </tr>
    `).join('')
    : '<tr><td colspan="7" class="empty">No matching campaigns in this range.</td></tr>';

  const tfoot = document.getElementById('spendsTableFoot');
  tfoot.innerHTML = campaigns.length ? `
    <tr class="pivot-total-row">
      <td class="pin pin-quarter">Total</td>
      <td>${fmtCurrency(kpi.spend)}${prevKpi ? deltaBadgeHtml(kpi.spend, prevKpi.spend) : ''}</td>
      <td>${fmtInt(kpi.clicks)}${prevKpi ? deltaBadgeHtml(kpi.clicks, prevKpi.clicks) : ''}</td>
      <td>${fmtInt(kpi.impressions)}${prevKpi ? deltaBadgeHtml(kpi.impressions, prevKpi.impressions) : ''}</td>
      <td>${fmtDec(kpi.ctr)}%${prevKpi ? deltaBadgeHtml(kpi.ctr, prevKpi.ctr) : ''}</td>
      <td>${fmtCurrency(kpi.cpm)}${prevKpi ? deltaBadgeHtml(kpi.cpm, prevKpi.cpm) : ''}</td>
      <td>${fmtCurrency(kpi.cpc)}${prevKpi ? deltaBadgeHtml(kpi.cpc, prevKpi.cpc) : ''}</td>
    </tr>
  ` : '';

  animateRowsIn(tbody.querySelectorAll('tr'));
  animateBadgesIn(document.querySelectorAll('#spendsTableBody .kpi-delta, #spendsTableFoot .kpi-delta'), 0.15);
}

function spendsSetKpiDelta(elId, curr, prev) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.innerHTML = prev === null || prev === undefined ? '' : deltaBadgeHtml(curr, prev);
  el.classList.toggle('hidden', !el.innerHTML);
  if (el.firstElementChild) animateBadgesIn([el.firstElementChild], 0);
}

function spendsRender() {
  if (!spendsLastData) return;
  const channelData = spendsLastData.regions[spendsActiveRegion][spendsActiveChannel];
  const kpi = channelData.kpi;
  const prevChannelData = spendsGetPrevChannelData();
  const prevKpi = prevChannelData ? prevChannelData.kpi : null;

  document.getElementById('spendsTotalSpend').textContent = fmtCurrency(kpi.spend);
  document.getElementById('spendsTotalClicks').textContent = fmtInt(kpi.clicks);
  document.getElementById('spendsCtr').textContent = `${fmtDec(kpi.ctr)}%`;
  document.getElementById('spendsCpm').textContent = fmtCurrency(kpi.cpm);

  spendsSetKpiDelta('spendsTotalSpendDelta', kpi.spend, prevKpi ? prevKpi.spend : null);
  spendsSetKpiDelta('spendsTotalClicksDelta', kpi.clicks, prevKpi ? prevKpi.clicks : null);
  spendsSetKpiDelta('spendsCtrDelta', kpi.ctr, prevKpi ? prevKpi.ctr : null);
  spendsSetKpiDelta('spendsCpmDelta', kpi.cpm, prevKpi ? prevKpi.cpm : null);

  spendsRenderRadar(kpi, channelData.campaigns.length);
  spendsRenderTable();
}

async function spendsLoad() {
  const status = document.getElementById('spendsStatus');
  status.textContent = 'Loading...';
  spendsUpdateCompareToggle();
  try {
    const res = await fetch(`/api/clg-spends?startDate=${spendsStartDate}&endDate=${spendsEndDate}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');

    spendsLastData = data;
    await spendsFetchPrevIfNeeded();
    spendsRenderDonut();
    spendsRenderRegionLegend();
    spendsRender();
    status.textContent = '';
  } catch (err) {
    status.textContent = 'Error: ' + err.message;
  }
}

document.getElementById('spendsDateRangeBtn').addEventListener('click', () => {
  spendsSelectionMode = spendsSelectionMode === 'range' ? 'single' : 'range';
  spendsPendingRangeStart = null;
  spendsRenderCalendar();
});
document.getElementById('spendsCalendarResetBtn').addEventListener('click', spendsResetDateRange);
document.getElementById('spendsCalendarPrevBtn').addEventListener('click', () => {
  spendsCalendarViewDate = new Date(Date.UTC(spendsCalendarViewDate.getUTCFullYear(), spendsCalendarViewDate.getUTCMonth() - 1, 1));
  spendsRenderCalendar();
});
document.getElementById('spendsCalendarNextBtn').addEventListener('click', () => {
  spendsCalendarViewDate = new Date(Date.UTC(spendsCalendarViewDate.getUTCFullYear(), spendsCalendarViewDate.getUTCMonth() + 1, 1));
  spendsRenderCalendar();
});
document.getElementById('spendsCalendarGrid').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-date]');
  if (!btn) return;
  spendsHandleDayClick(btn.dataset.date);
});

document.getElementById('spendsRegionDonut').addEventListener('click', (e) => {
  const seg = e.target.closest('[data-region]');
  if (!seg) return;
  spendsSelectRegion(seg.dataset.region);
});
document.getElementById('spendsRegionLegend').addEventListener('click', (e) => {
  const item = e.target.closest('[data-region]');
  if (!item) return;
  spendsSelectRegion(item.dataset.region);
});

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
  spendsRender();
});

document.getElementById('spendsGroupToggle').addEventListener('click', spendsToggleGroup);

function spendsDisableCompare() {
  spendsCompareEnabled = false;
  spendsPrevData = null;
  document.getElementById('spendsCompareToggle').classList.remove('active');
  document.getElementById('spendsCompareClose').classList.add('hidden');
  spendsRender();
}

document.getElementById('spendsCompareToggle').addEventListener('click', async (e) => {
  if (spendsCompareEnabled) {
    spendsDisableCompare();
    return;
  }
  spendsCompareEnabled = true;
  document.getElementById('spendsCompareToggle').classList.add('active');
  document.getElementById('spendsCompareClose').classList.remove('hidden');
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

// ---- Quick-range presets (7/14/30/60/90 days ending today), matching the
// canned windows LinkedIn/Meta Ads' own dashboards offer, as an alternative
// to manually picking two dates on the calendar. ----
function spendsUpdateQuickRangeActive() {
  const todayStr = new Date().toISOString().slice(0, 10);
  document.querySelectorAll('#spendsQuickRangeRow .quick-range-btn').forEach(btn => {
    const days = parseInt(btn.dataset.days, 10);
    const expectedStart = addDaysToDateStr(todayStr, -(days - 1));
    const isActive = spendsHasExplicitSelection && spendsEndDate === todayStr && spendsStartDate === expectedStart;
    btn.classList.toggle('active', isActive);
  });
}

function spendsApplyQuickRange(days) {
  const todayStr = new Date().toISOString().slice(0, 10);
  spendsSelectionMode = 'single';
  spendsPendingRangeStart = null;
  spendsEndDate = todayStr;
  spendsStartDate = addDaysToDateStr(todayStr, -(days - 1));
  spendsHasExplicitSelection = true;
  spendsCalendarViewDate = new Date(spendsEndDate + 'T00:00:00Z');
  spendsRenderCalendar();
  spendsLoad();
}

document.getElementById('spendsQuickRangeRow').addEventListener('click', (e) => {
  const btn = e.target.closest('.quick-range-btn');
  if (!btn) return;
  pulseScale(btn);
  spendsApplyQuickRange(parseInt(btn.dataset.days, 10));
});

renderCalendar();
load();
