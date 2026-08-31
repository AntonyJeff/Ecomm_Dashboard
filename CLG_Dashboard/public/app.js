const fmtInt = (n) => Math.round(n).toLocaleString('en-IN');
const fmtDec = (n) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Categorical palette (fixed order, never cycled/reassigned by rank) --
// matches the dataviz reference palette, validated for CVD-safe adjacent pairs.
const PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];

let activeRegion = 'India';
let activeStage = 'lead';
let lastData = null;

const METRIC_FMT = { leadAge: fmtDec, ndl: fmtInt, count: fmtInt };

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
      <th class="pivot-total-col">Total</th>
    </tr>
  `;
}

function metricRow({ quarterCell, subSourceCell, metric, cells, rowTotal, extraClass = '' }) {
  const fmt = METRIC_FMT[metric.key];
  return `
    <tr class="${extraClass}">
      ${quarterCell}
      ${subSourceCell}
      <td class="pin pin-metric${metric.bold ? ' pivot-cell-count' : ''}">${metric.label}</td>
      ${cells.map(cell => `<td class="pivot-cell${metric.bold ? ' pivot-cell-count' : ''}">${fmt(cell[metric.key])}</td>`).join('')}
      <td class="pivot-cell pivot-total-col${metric.bold ? ' pivot-cell-count' : ''}">${fmt(rowTotal[metric.key])}</td>
    </tr>
  `;
}

function renderPivotBody(pivot) {
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
      return metricRow({ quarterCell, subSourceCell, metric, cells: row.cells, rowTotal: row.rowTotal });
    }).join('');
  }).join('');
}

function renderPivotFoot(pivot) {
  const metrics = pivot.metrics;
  return metrics.map((metric, i) => {
    const quarterCell = i === 0 ? `<td class="pin pin-quarter" rowspan="${metrics.length}">Total</td>` : '';
    const subSourceCell = i === 0 ? `<td class="pin pin-subsource" rowspan="${metrics.length}"></td>` : '';
    return metricRow({ quarterCell, subSourceCell, metric, cells: pivot.columnTotals, rowTotal: pivot.grandTotal, extraClass: 'pivot-total-row' });
  }).join('');
}

function renderRegion(region, stage, data) {
  const template = document.getElementById('region-template');
  const node = template.content.cloneNode(true);

  node.querySelector('.stat-total-records').textContent = fmtInt(data.totalRecords);
  node.querySelector('.stat-lead-age').textContent = fmtInt(data.totalLeadAge);
  node.querySelector('.stat-ndl').textContent = fmtInt(data.totalNDL);

  // The top chart always groups by date only (even in 'simple' mode it's one
  // bar per quarter) -- its title uses the stage's date-axis label alone, not
  // the full outer/inner pivot hierarchy, which can differ (e.g. MQL's pivot
  // is Owner Team > Meeting Executed Date, but the chart itself has no
  // Owner Team breakdown at all).
  node.querySelector('.chart-title').textContent = data.chartMode === 'breakdown'
    ? `${data.dateAxisLabel} > ${data.pivot.innerLabel}`
    : data.dateAxisLabel;
  node.querySelector('.pivot-title').textContent = `${data.pivot.outerLabel} > ${data.pivot.innerLabel} × Lead Status`;

  const legendEl = node.querySelector('.legend');
  legendEl.innerHTML = data.chartMode === 'breakdown' ? renderLegend(data.subSourceOrder) : '';

  node.querySelector('.funnel-chart').innerHTML = data.chart.length
    ? renderChart(data)
    : '<div class="empty">No matching leads in this range.</div>';

  node.querySelector('.pivot-table thead').innerHTML = renderPivotHead(data.pivot.statusColumns, data.pivot.outerLabel, data.pivot.innerLabel);
  node.querySelector('.pivot-table tbody').innerHTML = renderPivotBody(data.pivot);
  node.querySelector('.pivot-table tfoot').innerHTML = data.pivot.rows.length ? renderPivotFoot(data.pivot) : '';

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

function render() {
  if (!lastData) return;
  const app = document.getElementById('app');
  app.innerHTML = '';
  const data = lastData.regions[activeRegion][activeStage];
  app.appendChild(activeStage === 'sql' ? renderSqlRegion(data) : renderRegion(activeRegion, activeStage, data));
}

async function load() {
  const startDate = document.getElementById('startDate').value;
  const endDate = document.getElementById('endDate').value;
  const status = document.getElementById('status');

  status.textContent = 'Loading...';
  try {
    const res = await fetch(`/api/clg-regions?startDate=${startDate}&endDate=${endDate}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');

    lastData = data;
    render();
    document.getElementById('lastUpdated').textContent = 'Updated ' + new Date(data.lastUpdated).toLocaleString();
    status.textContent = '';
  } catch (err) {
    status.textContent = 'Error: ' + err.message;
  }
}

document.getElementById('endDate').value = new Date().toISOString().slice(0, 10);
document.getElementById('filters').addEventListener('submit', (e) => {
  e.preventDefault();
  load();
});

document.getElementById('regionTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  activeRegion = btn.dataset.region;
  document.querySelectorAll('#regionTabs .tab').forEach(t => t.classList.toggle('active', t === btn));
  render();
});

document.getElementById('stageTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.subtab');
  if (!btn) return;
  activeStage = btn.dataset.stage;
  document.querySelectorAll('#stageTabs .subtab').forEach(t => t.classList.toggle('active', t === btn));
  render();
});

load();
