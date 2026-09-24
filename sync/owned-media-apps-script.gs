/**
 * Owned Media Refresh (Smartech) — Google Apps Script port.
 *
 * Two Smartech report emails land daily in antony.jefrin@netcore.ai from
 * admin@netcorecloud.com: one "Campaign_Multi_Email_Summary_Daily_T-1_<date>", one
 * "Campaign_Multi_Whatsapp_Summary_Daily_T-1_<date>" -- each with a
 * reports.netcoresmartech.com/jobs/....zip download link in the body. This script
 * downloads each, unzips the CSV inside, and appends every new campaign row straight
 * into the SAME dashboard sheet the rest of this project reads from -- the 'Email'
 * and 'Whatsapp' tabs, no separate Owned/Paid split (confirmed live: those tabs hold
 * every campaign, ecom and non-ecom alike -- api/clg-spends.js does its own
 * Ecomm/region filtering by Campaign Name when it READS these tabs, so this script's
 * only job is to get every row in accurately, not to pre-filter anything).
 *
 * Confirmed against a real downloaded whatsapp.csv: Smartech's own CSV columns are
 * (Campaign Id, Campaign Name, Channel, Status, Campaign Type, Message Type, Sender,
 * Sent Date, Published, Sent, Delivered, Delivered %, Total Opened/Read, Unique
 * Opened, Unique Opened %, Total Clicked, Unique Clicked, Unique Clicked %,
 * Conversions, Conversion %, Unique Conversions, Revenue, Not Sent, Not Sent %,
 * Undelivered, Undelivered %, Tags, List Names, List IDs, Segment Names, Segment IDs)
 * -- an (almost) exact match for the sheet's own column names, and the Email report
 * follows the same structure. So this is a straight per-row copy matched by column
 * NAME (handles either side having columns the other doesn't, and survives a column
 * being reordered), NOT a sum/aggregate across rows -- each CSV row is already one
 * specific campaign, not a split-test variant that needs combining with others.
 *
 * Dedup is by Campaign Id (Smartech's own id, e.g. 906) rather than Campaign Name --
 * a real, stable, unique key already present in both the CSV and the sheet, unlike
 * name which is at least theoretically reusable.
 *
 * Runs entirely under the Google account that authorizes this script (no exportable
 * refresh token, no external OAuth client, nothing for Google to revoke the way the
 * interim GMAIL_REFRESH_TOKEN kept getting revoked).
 */

// The real, shared dashboard sheet -- same CLG_SHEET_ID the Vercel API
// (api/clg-regions.js / api/clg-spends.js) reads.
const CLG_SHEET_ID = '15zOa2W1SZwPRAbrKzqD6RDcGA9oW8CXomhkIHLwlqew';
const EMAIL_TAB_NAME = 'Email';
const WHATSAPP_TAB_NAME = 'Whatsapp';
// Smartech's report file server rejects requests with no/default User-Agent (403).
const FETCH_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };

// ---- CSV parsing ----
function parseCsv_(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.length > 1 || row[0] !== '') rows.push(row);
        row = [];
      } else field += c;
    }
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}
function findCol_(headers, name) {
  return headers.findIndex(function (h) { return (h || '').toString().trim().toLowerCase() === name.toLowerCase(); });
}
// Smartech's CSV export can carry a leading UTF-8 BOM -- left uncaught, it would
// silently break matching the FIRST header cell (e.g. "Campaign Id" would compare as
// "﻿Campaign Id" and never match), with no error thrown anywhere.
function stripBom_(text) {
  return text.replace(/^﻿/, '');
}

// ---- Gmail: find the LATEST matching Smartech report email, get the CSV out of it ----
// Only ever the single newest match, not every historical report still sitting in the
// inbox -- these are daily "T-1" snapshots, so re-scanning old ones every run would
// just waste a Gmail search + a zip download per run for reports that are already
// fully synced (the Campaign Id dedup in appendReportToSheet_ would still stop them
// from becoming duplicate ROWS, but there's no reason to even fetch them).
//
// The query anchors on "Scheduled Daily Report:" (a plain, underscore-free phrase that
// both real subjects share verbatim) rather than the underscore-heavy report name --
// Gmail's search tokenizer can split on underscores in ways that make a quoted phrase
// like "Campaign_Multi_Email_Summary" NOT match a subject that visibly contains that
// exact text (this was very likely why the first version scanned 0 reports despite
// the emails clearly being there). The precise Email-vs-WhatsApp match still happens
// in code via subjectContains, same as before, just as the ONLY filter now rather than
// a redundant second one.
function fetchLatestReportCsv_(subjectContains) {
  const query = '(from:admin@netcorecloud.com OR from:admin@netcore.ai) "Scheduled Daily Report"';
  const threads = GmailApp.search(query, 0, 20);
  let latestMsg = null;
  let latestDate = null;
  for (let t = 0; t < threads.length; t++) {
    const messages = threads[t].getMessages();
    for (let m = 0; m < messages.length; m++) {
      const msg = messages[m];
      const subject = msg.getSubject() || '';
      if (subject.indexOf(subjectContains) === -1) continue;
      const date = msg.getDate();
      if (!latestDate || date > latestDate) { latestDate = date; latestMsg = msg; }
    }
  }
  if (!latestMsg) return null;
  Logger.log('Using report dated ' + latestDate + ': "' + latestMsg.getSubject() + '"');
  // Confirmed live: both reports are the "click to download" link form, not a direct
  // attachment -- extractCsvFromAttachment_ is checked first anyway in case that ever
  // changes, but is a no-op today.
  return extractCsvFromAttachment_(latestMsg) || extractCsvFromLink_(latestMsg);
}

function extractCsvFromAttachment_(msg) {
  const attachments = msg.getAttachments();
  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i];
    const name = (att.getName() || '').toLowerCase();
    if (name.endsWith('.zip')) {
      const files = Utilities.unzip(att);
      const csvFile = files.filter(function (f) { return f.getName().toLowerCase().endsWith('.csv'); })[0];
      if (csvFile) return stripBom_(csvFile.getDataAsString('UTF-8'));
    } else if (name.endsWith('.csv')) {
      return stripBom_(att.getDataAsString('UTF-8'));
    }
  }
  return null;
}

// The download link is usually a hyperlink (href) rather than visible text, so check
// the HTML body first; fall back to the plain-text body just in case.
function extractCsvFromLink_(msg) {
  const html = msg.getBody();
  const plain = msg.getPlainBody();
  const linkMatch =
    html.match(/href="(https:\/\/reports\.netcoresmartech\.com\/jobs\/[^"]+)"/) ||
    plain.match(/(https:\/\/reports\.netcoresmartech\.com\/jobs\/[^\s"'<>]+)/);
  if (!linkMatch) return null;
  const url = linkMatch[1].replace(/&amp;/g, '&');

  const resp = UrlFetchApp.fetch(url, { headers: FETCH_HEADERS, muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) return null;
  const zipBlob = resp.getBlob();
  const files = Utilities.unzip(zipBlob);
  const csvFile = files.filter(function (f) { return f.getName().toLowerCase().endsWith('.csv'); })[0];
  if (!csvFile) return null;
  return stripBom_(csvFile.getDataAsString('UTF-8'));
}

// ---- Sheet write: copies each CSV data row into the target tab, column-name-matched
// against whichever header the CSV and the sheet each actually have, deduped against
// what's already in the sheet by Campaign Id. ----
function appendReportToSheet_(csvText, tabName, label) {
  const rows = parseCsv_(csvText);
  if (rows.length < 2) { Logger.log(label + ': CSV had no data rows.'); return; }
  const csvHeaders = rows[0];
  Logger.log(label + ' CSV headers: ' + csvHeaders.join(' | '));

  const csvIdCol = findCol_(csvHeaders, 'Campaign Id');
  if (csvIdCol === -1) { Logger.log(label + ': ERROR -- CSV has no "Campaign Id" column, aborting.'); return; }

  const sheet = SpreadsheetApp.openById(CLG_SHEET_ID).getSheetByName(tabName);
  if (!sheet) { Logger.log(label + ': ERROR -- no tab named "' + tabName + '" found in the sheet.'); return; }
  const sheetHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const sheetIdCol = findCol_(sheetHeaders, 'Campaign Id');
  if (sheetIdCol === -1) { Logger.log(label + ': ERROR -- "' + tabName + '" has no "Campaign Id" column.'); return; }

  const lastRow = sheet.getLastRow();
  const existingIds = {};
  if (lastRow > 1) {
    sheet.getRange(2, sheetIdCol + 1, lastRow - 1, 1).getValues().forEach(function (r) { existingIds[r[0]] = true; });
  }

  // Maps each sheet column to the matching CSV column index once, up front, instead
  // of re-searching per row.
  const sheetColToCsvCol = sheetHeaders.map(function (h) { return findCol_(csvHeaders, (h || '').toString().trim()); });
  // Every other column here is copied through as plain text/numbers, which is fine --
  // but the existing rows' "Sent Date" is a real Sheets date/time value (the old sync
  // process parsed it before writing), not text. Copying Smartech's raw date STRING
  // through unchanged would store it as literal text instead, which not only displays
  // differently from the existing rows but risks the dashboard's date-range filtering
  // silently skipping it. Parsing it into an actual Date here makes Apps Script write
  // it as a proper date/time value, same as every other row, regardless of which exact
  // string format Smartech happens to use for a given report.
  const sentDateSheetCol = findCol_(sheetHeaders, 'Sent Date');

  const newRows = [];
  const newNames = [];
  for (let i = 1; i < rows.length; i++) {
    const csvRow = rows[i];
    const id = csvRow[csvIdCol];
    if (!id || existingIds[id]) continue;
    existingIds[id] = true; // guards against the same id appearing twice in one CSV
    const newRow = sheetColToCsvCol.map(function (csvCol) { return csvCol === -1 ? '' : csvRow[csvCol]; });
    if (sentDateSheetCol !== -1 && newRow[sentDateSheetCol]) {
      const parsed = new Date(newRow[sentDateSheetCol]);
      if (!isNaN(parsed.getTime())) {
        newRow[sentDateSheetCol] = parsed;
      } else {
        Logger.log(label + ': WARNING -- could not parse Sent Date "' + newRow[sentDateSheetCol] + '" for campaign ' + id + ', left as text.');
      }
    }
    newRows.push(newRow);
    const nameCol = findCol_(csvHeaders, 'Campaign Name');
    newNames.push(nameCol !== -1 ? csvRow[nameCol] : id);
  }

  Logger.log(label + ': ' + (rows.length - 1) + ' campaigns in report, ' + newRows.length + ' are new.');
  if (newRows.length === 0) return;
  sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, sheetHeaders.length).setValues(newRows);
  Logger.log(label + ': appended ' + newNames.join(', '));
}

/**
 * One-off cleanup, run manually ONCE: fixes any "Sent Date" cell that was already
 * written as plain text (rows appended before the Date-parsing fix above landed --
 * e.g. two rows synced during testing) so it becomes a real date/time value like every
 * other row. Safe to run more than once -- cells that are already a real Date are left
 * untouched, only actual text values get converted.
 */
function fixTextSentDates_(tabName) {
  const sheet = SpreadsheetApp.openById(CLG_SHEET_ID).getSheetByName(tabName);
  if (!sheet) { Logger.log('fixTextSentDates_: no tab named "' + tabName + '".'); return; }
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const dateCol = findCol_(headers, 'Sent Date');
  if (dateCol === -1) { Logger.log('fixTextSentDates_: "' + tabName + '" has no Sent Date column.'); return; }

  const range = sheet.getRange(2, dateCol + 1, lastRow - 1, 1);
  const values = range.getValues();
  let fixed = 0;
  const out = values.map(function (row) {
    const v = row[0];
    if (typeof v === 'string' && v) {
      const parsed = new Date(v);
      if (!isNaN(parsed.getTime())) { fixed++; return [parsed]; }
    }
    return [v];
  });
  range.setValues(out);
  Logger.log('fixTextSentDates_(' + tabName + '): fixed ' + fixed + ' text date(s).');
}
function fixAllTextSentDates() {
  fixTextSentDates_(EMAIL_TAB_NAME);
  fixTextSentDates_(WHATSAPP_TAB_NAME);
}

/**
 * Main entry point. Run this once manually first (to grant permissions), then set up
 * the daily trigger via runOneTimeSetup().
 */
function runSync() {
  Logger.log('=== EMAIL ===');
  const emailCsv = fetchLatestReportCsv_('Campaign_Multi_Email_Summary');
  if (emailCsv) appendReportToSheet_(emailCsv, EMAIL_TAB_NAME, 'Email');
  else Logger.log('Email: no matching report email found.');

  Logger.log('=== WHATSAPP ===');
  const waCsv = fetchLatestReportCsv_('Campaign_Multi_Whatsapp_Summary');
  if (waCsv) appendReportToSheet_(waCsv, WHATSAPP_TAB_NAME, 'Whatsapp');
  else Logger.log('Whatsapp: no matching report email found.');

  Logger.log('=== Done ===');
}

/**
 * Run this ONCE (from the function dropdown) to schedule runSync() to run
 * automatically every night. Safe to run again later — clears any existing trigger
 * for runSync first, so it never creates duplicates.
 *
 * atHour() fires at that hour in the SCRIPT PROJECT's own time zone, not UTC and not
 * necessarily your account's time zone -- check/set it under the gear icon ("Project
 * Settings") on the left sidebar before relying on this. The report emails land
 * around 1:15 AM (per the Gmail timestamps), so 2 AM leaves a safety margin.
 */
function runOneTimeSetup() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runSync') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runSync')
    .timeBased()
    .everyDays(1)
    .atHour(2) // 2 AM in the project's time zone -- see note above
    .create();
  Logger.log('Daily trigger created for runSync().');
}

/**
 * Diagnostic only -- run this manually if runSync ever reports "no matching report
 * email found" again, to rule out the single most likely cause: this script running
 * under a different Google account than the one that actually receives the Smartech
 * emails (GmailApp.search only ever searches the account that authorized the script).
 */
function whoAmI() {
  Logger.log('Running as: ' + Session.getActiveUser().getEmail());
}
