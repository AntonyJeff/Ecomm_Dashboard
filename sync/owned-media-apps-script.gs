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
const MAX_REPORTS_TO_SCAN = 10;
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

// ---- Gmail: find matching Smartech report emails, get the CSV out of them ----
// Filtering by subject IN THE SEARCH ITSELF (not after fetching each message) is what
// keeps this cheap.
function fetchMatchingReportCsvs_(subjectContains, maxCount) {
  const query = '(from:admin@netcorecloud.com OR from:admin@netcore.ai) subject:"' + subjectContains + '"';
  const threads = GmailApp.search(query, 0, 40);
  const csvs = [];
  for (let t = 0; t < threads.length && csvs.length < maxCount; t++) {
    const messages = threads[t].getMessages();
    for (let m = 0; m < messages.length && csvs.length < maxCount; m++) {
      const msg = messages[m];
      const subject = msg.getSubject() || '';
      if (subject.indexOf(subjectContains) === -1) continue; // safety net; the query above already filters

      // Confirmed live: both reports are the "click to download" link form, not a
      // direct attachment -- extractCsvFromAttachment_ is checked first anyway in
      // case that ever changes, but is a no-op today.
      const csvText = extractCsvFromAttachment_(msg) || extractCsvFromLink_(msg);
      if (csvText) csvs.push(csvText);
    }
  }
  return csvs;
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

  const newRows = [];
  const newNames = [];
  for (let i = 1; i < rows.length; i++) {
    const csvRow = rows[i];
    const id = csvRow[csvIdCol];
    if (!id || existingIds[id]) continue;
    existingIds[id] = true; // guards against the same id appearing twice in one CSV
    newRows.push(sheetColToCsvCol.map(function (csvCol) { return csvCol === -1 ? '' : csvRow[csvCol]; }));
    const nameCol = findCol_(csvHeaders, 'Campaign Name');
    newNames.push(nameCol !== -1 ? csvRow[nameCol] : id);
  }

  Logger.log(label + ': ' + (rows.length - 1) + ' campaigns in report, ' + newRows.length + ' are new.');
  if (newRows.length === 0) return;
  sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, sheetHeaders.length).setValues(newRows);
  Logger.log(label + ': appended ' + newNames.join(', '));
}

/**
 * Main entry point. Run this once manually first (to grant permissions), then set up
 * the daily trigger via runOneTimeSetup().
 */
function runSync() {
  Logger.log('=== EMAIL ===');
  const emailCsvs = fetchMatchingReportCsvs_('Campaign_Multi_Email_Summary', MAX_REPORTS_TO_SCAN);
  Logger.log('Matching email reports scanned: ' + emailCsvs.length);
  emailCsvs.forEach(function (csv) { appendReportToSheet_(csv, EMAIL_TAB_NAME, 'Email'); });

  Logger.log('=== WHATSAPP ===');
  const waCsvs = fetchMatchingReportCsvs_('Campaign_Multi_Whatsapp_Summary', MAX_REPORTS_TO_SCAN);
  Logger.log('Matching whatsapp reports scanned: ' + waCsvs.length);
  waCsvs.forEach(function (csv) { appendReportToSheet_(csv, WHATSAPP_TAB_NAME, 'Whatsapp'); });

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
