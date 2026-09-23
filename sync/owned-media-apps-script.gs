/**
 * Owned Media Refresh (Smartech) — Google Apps Script port.
 *
 * Replaces sync-owned-media.mjs / the GitHub Actions "Owned Media Refresh" workflow.
 * Runs entirely under the Google account that authorizes this script (no exportable
 * refresh token, no external OAuth client, nothing for Google to revoke the way the
 * interim GMAIL_REFRESH_TOKEN kept getting revoked).
 *
 * 2026-09: Smartech now delivers these reports as a .zip file attached directly to
 * the email, not a "click to download" link — confirmed live (a report email opened
 * in Gmail showed the .zip as a normal attachment, with no download link in the body).
 * fetchMatchingReportCsvs_ previously only understood the link form (it searched Gmail
 * for the word "Download" and looked for an href to reports.netcoresmartech.com),
 * which is almost certainly why nothing was landing in the sheet -- the attachment
 * form was invisible to it. It now checks the message's attachments first and falls
 * back to the old link-scraping behavior, so either delivery form still works.
 */

// ---- Constants (mirrors sync-owned-media.mjs exactly) ----
const CLG_PERF_SHEET_ID = '16TFxFnmEVcz9cACELWvqCRVtiQsgUBU-4mI7HrE599E';
const TANVI_EMAIL_NAME = 'tanvi dhotre';
const TANVI_WHATSAPP_SENDER = '8657948476';
const MAX_EMAILS_TO_SCAN = 10;
// Smartech's report file server rejects requests with no/default User-Agent (403).
// Only used by the link-based fallback path now -- the attachment path never hits
// Smartech's server at all.
const FETCH_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };

function isClg_(name) {
  return (name || '').toLowerCase().indexOf('clg') !== -1;
}

// ---- CSV parsing (verbatim port of the Node version) ----
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
  return headers.findIndex(function (h) { return h.trim() === name; });
}
// Smartech's CSV export can carry a leading UTF-8 BOM -- left uncaught, it would
// silently corrupt EVERY row: the BOM lands on the first header cell, so
// findCol_(headers, 'Campaign Name') stops matching (compares "﻿Campaign Name"
// against "Campaign Name"), returns -1, and every row's r[nameCol] becomes
// undefined with no error thrown anywhere. (The previous version had
// `.replace(/^/, '')` here, which is a no-op -- matches and replaces an empty
// string at position 0 -- almost certainly a broken attempt at this same fix.)
function stripBom_(text) {
  return text.replace(/^﻿/, '');
}

// ---- Gmail: find matching Smartech report emails, get the CSV out of them ----
// Filtering by subject IN THE SEARCH ITSELF (not after fetching each message) is what
// keeps this cheap — same lesson learned in the Node version's quota-exceeded bug.
// Query is subject-only now (not `"Download"`) since the attachment form of this
// email may not contain that word anywhere in its body.
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

      const csvText = extractCsvFromAttachment_(msg) || extractCsvFromLink_(msg);
      if (csvText) csvs.push(csvText);
    }
  }
  return csvs;
}

// Primary path as of 2026-09: the report .zip is attached directly to the email.
// A GmailAttachment is itself a Blob, so it can go straight into Utilities.unzip
// with no download step at all.
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

// Fallback path: the original "click here to download" link form, kept in case
// Smartech ever reverts or sends a mix of both. The download link is usually a
// hyperlink (href) rather than visible text, so check the HTML body first; fall
// back to the plain-text body just in case.
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

// ---- Aggregation (verbatim port — groups split-test rows by Campaign Name; across
// multiple reports, only the FIRST occurrence of a name is kept) ----
function aggregateEmail_(csvs, keepRow) {
  const groups = {};
  csvs.forEach(function (csvText) {
    const rows = parseCsv_(csvText);
    const headers = rows[0];
    const nameCol = findCol_(headers, 'Campaign Name');
    const senderCol = findCol_(headers, 'Sender');
    const sentDateCol = findCol_(headers, 'Sent Date');
    const sentCol = findCol_(headers, 'Sent');
    const deliveredCol = findCol_(headers, 'Delivered');
    const uniqOpenedCol = findCol_(headers, 'Unique Opened');
    const uniqClickedCol = findCol_(headers, 'Unique Clicked');
    const typeCol = findCol_(headers, 'Campaign Type');
    const subjectCol = findCol_(headers, 'Subject line or Title');

    const perReport = {};
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const name = r[nameCol];
      const sender = (r[senderCol] || '').toLowerCase();
      if (!keepRow(name, sender)) continue;
      if (!perReport[name]) {
        perReport[name] = {
          campaignName: name, sentDate: r[sentDateCol], sent: 0, delivered: 0,
          uniqueOpened: 0, uniqueClicked: 0, campaignType: r[typeCol], subject: r[subjectCol],
        };
      }
      const g = perReport[name];
      if (r[sentDateCol] < g.sentDate) g.sentDate = r[sentDateCol];
      g.sent += Number(r[sentCol]) || 0;
      g.delivered += Number(r[deliveredCol]) || 0;
      g.uniqueOpened += Number(r[uniqOpenedCol]) || 0;
      g.uniqueClicked += Number(r[uniqClickedCol]) || 0;
    }
    Object.keys(perReport).forEach(function (name) {
      if (!groups[name]) groups[name] = perReport[name];
    });
  });
  return Object.keys(groups).map(function (k) { return groups[k]; });
}


function aggregateWhatsapp_(csvs, keepRow) {
  const groups = {};
  csvs.forEach(function (csvText) {
    const rows = parseCsv_(csvText);
    const headers = rows[0];
    const nameCol = findCol_(headers, 'Campaign Name');
    const typeCol = findCol_(headers, 'Campaign Type');
    const senderCol = findCol_(headers, 'Sender');
    const sentDateCol = findCol_(headers, 'Sent Date');
    const sentCol = findCol_(headers, 'Sent');
    const deliveredCol = findCol_(headers, 'Delivered');
    const uniqOpenedCol = findCol_(headers, 'Unique Opened');
    const uniqClickedCol = findCol_(headers, 'Unique Clicked');

    const perReport = {};
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const name = r[nameCol];
      const sender = (r[senderCol] || '').toString().trim();
      if (!keepRow(name, sender)) continue;
      if (!perReport[name]) {
        perReport[name] = {
          campaignName: name, sender: sender, campaignType: r[typeCol], sentDate: r[sentDateCol],
          sent: 0, delivered: 0, uniqueOpened: 0, uniqueClicked: 0,
        };
      }
      const g = perReport[name];
      if (r[sentDateCol] < g.sentDate) g.sentDate = r[sentDateCol];
      g.sent += Number(r[sentCol]) || 0;
      g.delivered += Number(r[deliveredCol]) || 0;
      g.uniqueOpened += Number(r[uniqOpenedCol]) || 0;
      g.uniqueClicked += Number(r[uniqClickedCol]) || 0;
    }
    Object.keys(perReport).forEach(function (name) {
      if (!groups[name]) groups[name] = perReport[name];
    });
  });
  return Object.keys(groups).map(function (k) { return groups[k]; });
}

// ---- Sheet writes (SpreadsheetApp instead of the Sheets REST API; same dedup-by-name
// + same exact column layout as sync-owned-media.mjs's processEmail/processWhatsapp) ----
function appendNewRows_(tabName, allRows, label) {
  if (allRows.length === 0) { Logger.log(label + ': nothing to append.'); return; }
  const sheet = SpreadsheetApp.openById(CLG_PERF_SHEET_ID).getSheetByName(tabName);
  const range = sheet.getLastRow() + 1;
  sheet.getRange(range, 1, allRows.length, allRows[0].length).setValues(allRows);
}

function processEmail_(campaigns, tabName, label) {
  const sheet = SpreadsheetApp.openById(CLG_PERF_SHEET_ID).getSheetByName(tabName);
  const data = sheet.getDataRange().getValues();
  const existingNames = {};
  for (let i = 1; i < data.length; i++) existingNames[data[i][1]] = true;
  const newOnes = campaigns.filter(function (c) { return !existingNames[c.campaignName]; });
  Logger.log(label + ': ' + campaigns.length + ' campaigns found across scanned reports, ' + newOnes.length + ' are new.');
  if (newOnes.length === 0) return;
  const rows = newOnes.map(function (g) {
    return [
      '', g.campaignName, g.campaignType || '', '', g.subject || '', '', g.sentDate, '',
      g.sent, g.delivered,
      g.sent ? Math.round((g.delivered / g.sent) * 10000) / 100 : '',
      '', g.uniqueOpened,
      g.delivered ? Math.round((g.uniqueOpened / g.delivered) * 10000) / 100 : '',
      '', g.uniqueClicked,
      g.delivered ? Math.round((g.uniqueClicked / g.delivered) * 10000) / 100 : '',
      '', '', '', '', '', '', '', '', '',
    ];
  });
  appendNewRows_(tabName, rows, label);
  Logger.log(label + ': appended ' + newOnes.map(function (g) { return g.campaignName; }).join(', '));
}

function processWhatsapp_(campaigns, tabName, label) {
  const sheet = SpreadsheetApp.openById(CLG_PERF_SHEET_ID).getSheetByName(tabName);
  const data = sheet.getDataRange().getValues();
  const existingNames = {};
  for (let i = 1; i < data.length; i++) existingNames[data[i][1]] = true;
  const newOnes = campaigns.filter(function (c) { return !existingNames[c.campaignName]; });
  Logger.log(label + ': ' + campaigns.length + ' campaigns found across scanned reports, ' + newOnes.length + ' are new.');
  if (newOnes.length === 0) return;
  const rows = newOnes.map(function (g) {
    return [
      '', g.campaignName, g.campaignType || '', g.sender || '', g.sentDate,
      g.sent, g.delivered,
      g.sent ? Math.round((g.delivered / g.sent) * 10000) / 100 : '',
      '', g.uniqueOpened,
      g.delivered ? Math.round((g.uniqueOpened / g.delivered) * 10000) / 100 : '',
      '', g.uniqueClicked,
      g.delivered ? Math.round((g.uniqueClicked / g.delivered) * 10000) / 100 : '',
      '', '', '', '',
    ];
  });
  appendNewRows_(tabName, rows, label);
  Logger.log(label + ': appended ' + newOnes.map(function (g) { return g.campaignName; }).join(', '));
}

/**
 * Main entry point. Run this once manually first (to grant permissions), then set up
 * the daily trigger via runOneTimeSetup().
 */
function runSync() {
  Logger.log('=== EMAIL (fetch once, feeds both Owned + Paid) ===');
  const emailCsvs = fetchMatchingReportCsvs_('Campaign_Multi_Email_Summary', MAX_EMAILS_TO_SCAN);
  Logger.log('Matching email reports scanned: ' + emailCsvs.length);

  Logger.log('--- Owned Media (Tanvi only) ---');
  const tanviEmail = aggregateEmail_(emailCsvs, function (name, sender) { return sender.indexOf(TANVI_EMAIL_NAME) !== -1; });
  processEmail_(tanviEmail, 'Email Campaigns', 'Email (Owned)');

  Logger.log('--- Paid Media (everyone else, CLG-tagged only) ---');
  const paidEmail = aggregateEmail_(emailCsvs, function (name, sender) { return sender.indexOf(TANVI_EMAIL_NAME) === -1 && isClg_(name); });
  processEmail_(paidEmail, 'Email Campaigns - Paid Media', 'Email (Paid)');

  Logger.log('=== WHATSAPP (Smartech) - Paid Media only ===');
  Logger.log("(Tanvi's WhatsApp runs through CPaaS, not Smartech, and is filled by manual paste - see clg-owned-media.js)");
  const waCsvs = fetchMatchingReportCsvs_('Campaign_Multi_Whatsapp_Summary', MAX_EMAILS_TO_SCAN);
  Logger.log('Matching whatsapp reports scanned: ' + waCsvs.length);
  const paidWhatsapp = aggregateWhatsapp_(waCsvs, function (name, sender) { return sender !== TANVI_WHATSAPP_SENDER; });
  processWhatsapp_(paidWhatsapp, 'Whatsapp campaign - Paid Media', 'WhatsApp (Paid)');

  Logger.log('=== Done ===');
}

/**
 * Run this ONCE (from the function dropdown) to schedule runSync() to run
 * automatically every night. Safe to run again later — clears any existing trigger
 * for runSync first, so it never creates duplicates.
 */
function runOneTimeSetup() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runSync') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runSync')
    .timeBased()
    .everyDays(1)
    .atHour(21) // ~21:00 UTC, matching the old GitHub Actions schedule (20:30 UTC)
    .create();
  Logger.log('Daily trigger created for runSync().');
}
