/**
 * Owned Media Refresh (Smartech) — Google Apps Script port.
 *
 * Two Smartech report emails land daily in antony.jefrin@netcore.ai from
 * admin@netcorecloud.com: one "Campaign_Multi_Email_Summary_Daily_T-1_<date>", one
 * "Campaign_Multi_Whatsapp_Summary_Daily_T-1_<date>" -- each with a
 * reports.netcoresmartech.com/jobs/....zip download link in the body (confirmed live).
 * This script downloads each, unzips the CSV inside, and appends every new campaign
 * row straight into the SAME dashboard sheet the rest of this project reads from --
 * the 'Email' and 'Whatsapp' tabs, no separate Owned/Paid split (confirmed live: those
 * tabs hold every campaign, ecom and non-ecom alike -- api/clg-spends.js does its own
 * Ecomm/region filtering by Campaign Name when it READS these tabs, so this script's
 * only job is to get every row in accurately, not to pre-filter anything).
 *
 * api/clg-spends.js reads exactly 8 columns from these tabs by NAME (not position):
 * Campaign Name, Sent Date, Sent, Delivered, Total Opened/Read, Unique Opened,
 * Total Clicked, Unique Clicked -- getting those 8 right is what actually matters for
 * the live Spends tab; every other column in the sheet (Campaign Id, Channel, Status,
 * Delivered %, ...) is presentational and filled on a best-effort basis below.
 *
 * Runs entirely under the Google account that authorizes this script (no exportable
 * refresh token, no external OAuth client, nothing for Google to revoke the way the
 * interim GMAIL_REFRESH_TOKEN kept getting revoked).
 */

// This is the real, shared dashboard sheet -- same CLG_SHEET_ID the Vercel API
// (api/clg-regions.js / api/clg-spends.js) reads, confirmed against
// https://docs.google.com/spreadsheets/d/15zOa2W1SZwPRAbrKzqD6RDcGA9oW8CXomhkIHLwlqew
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
// Tries each candidate header name in order (case/whitespace-insensitive) and returns
// the first column index that exists -- Smartech's exact field naming for a couple of
// these (Total Opened / Total Clicked, Campaign Id) hasn't been confirmed against a
// real downloaded CSV yet, so this tries the likely variants instead of assuming one.
// runSync() logs the real header row on every run specifically so a wrong guess here
// is visible immediately in the execution log rather than silently leaving a column
// blank forever.
function findColAny_(headers, candidates) {
  for (let i = 0; i < candidates.length; i++) {
    const idx = headers.findIndex(function (h) { return (h || '').toString().trim().toLowerCase() === candidates[i].toLowerCase(); });
    if (idx !== -1) return idx;
  }
  return -1;
}
// Smartech's CSV export can carry a leading UTF-8 BOM -- left uncaught, it would
// silently corrupt EVERY row: the BOM lands on the first header cell, so header
// matching stops working for that one column with no error thrown anywhere.
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

// ---- Aggregation -- groups split-test rows by Campaign Name (a campaign run as an
// A/B test appears as multiple rows in Smartech's export, one per variant); summed
// into one row per campaign name. Across multiple reports scanned in one run, only
// the FIRST occurrence of a name is kept (a campaign shouldn't be double-counted if
// it happens to show up in more than one scanned report). No Ecomm/region filtering
// here -- that happens when the dashboard READS this sheet, not when writing to it,
// so every campaign (BFSI, webinars, whatever) gets appended, matching what's already
// in the sheet today. ----
function aggregateCampaigns_(csvs) {
  const groups = {};
  csvs.forEach(function (csvText) {
    const rows = parseCsv_(csvText);
    if (rows.length < 2) return;
    const headers = rows[0];
    Logger.log('CSV headers seen: ' + headers.join(' | '));
    const cols = {
      campaignId: findColAny_(headers, ['Campaign ID', 'Campaign Id', 'CampaignId']),
      campaignName: findColAny_(headers, ['Campaign Name']),
      campaignType: findColAny_(headers, ['Campaign Type']),
      messageType: findColAny_(headers, ['Message Type']),
      sender: findColAny_(headers, ['Sender']),
      sentDate: findColAny_(headers, ['Sent Date']),
      sent: findColAny_(headers, ['Sent']),
      delivered: findColAny_(headers, ['Delivered']),
      totalOpened: findColAny_(headers, ['Total Opened', 'Total Read', 'Total Opened/Read']),
      uniqueOpened: findColAny_(headers, ['Unique Opened']),
      totalClicked: findColAny_(headers, ['Total Clicked']),
      uniqueClicked: findColAny_(headers, ['Unique Clicked']),
      subject: findColAny_(headers, ['Subject line or Title', 'Subject']),
    };

    const perReport = {};
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const name = cols.campaignName !== -1 ? r[cols.campaignName] : '';
      if (!name) continue;
      if (!perReport[name]) {
        perReport[name] = {
          campaignId: cols.campaignId !== -1 ? r[cols.campaignId] : '',
          campaignName: name,
          campaignType: cols.campaignType !== -1 ? r[cols.campaignType] : '',
          messageType: cols.messageType !== -1 ? r[cols.messageType] : '',
          sender: cols.sender !== -1 ? r[cols.sender] : '',
          sentDate: cols.sentDate !== -1 ? r[cols.sentDate] : '',
          subject: cols.subject !== -1 ? r[cols.subject] : '',
          sent: 0, delivered: 0, totalOpened: 0, uniqueOpened: 0, totalClicked: 0, uniqueClicked: 0,
        };
      }
      const g = perReport[name];
      if (cols.sentDate !== -1 && r[cols.sentDate] < g.sentDate) g.sentDate = r[cols.sentDate];
      if (cols.sent !== -1) g.sent += Number(r[cols.sent]) || 0;
      if (cols.delivered !== -1) g.delivered += Number(r[cols.delivered]) || 0;
      if (cols.totalOpened !== -1) g.totalOpened += Number(r[cols.totalOpened]) || 0;
      if (cols.uniqueOpened !== -1) g.uniqueOpened += Number(r[cols.uniqueOpened]) || 0;
      if (cols.totalClicked !== -1) g.totalClicked += Number(r[cols.totalClicked]) || 0;
      if (cols.uniqueClicked !== -1) g.uniqueClicked += Number(r[cols.uniqueClicked]) || 0;
    }
    Object.keys(perReport).forEach(function (name) {
      if (!groups[name]) groups[name] = perReport[name];
    });
  });
  return Object.keys(groups).map(function (k) { return groups[k]; });
}

// Builds one sheet row per aggregated campaign, matching whatever the target tab's
// OWN header row actually is (by name, not a hardcoded position) -- so this works
// against 'Email' and 'Whatsapp' even though they don't have identical column sets,
// and keeps working if a column ever gets reordered/added/removed in the sheet
// itself. Any header the sheet has that isn't one of these known fields is just left
// blank for the new row rather than guessed at.
function buildFieldMap_(g, channelLabel) {
  const deliveredPct = g.sent ? Math.round((g.delivered / g.sent) * 10000) / 100 : '';
  const uniqueOpenedPct = g.delivered ? Math.round((g.uniqueOpened / g.delivered) * 10000) / 100 : '';
  const uniqueClickedPct = g.delivered ? Math.round((g.uniqueClicked / g.delivered) * 10000) / 100 : '';
  return {
    'campaign id': g.campaignId || '',
    'campaign name': g.campaignName,
    'channel': channelLabel,
    'status': 'Sent',
    'campaign type': g.campaignType || '',
    'message type': g.messageType || '',
    'sender': g.sender || '',
    'sent date': g.sentDate,
    'published': g.sent,
    'sent': g.sent,
    'delivered': g.delivered,
    'delivered %': deliveredPct,
    'total opened/read': g.totalOpened || '',
    'total opened': g.totalOpened || '',
    'total read': g.totalOpened || '',
    'unique opened': g.uniqueOpened,
    'unique opened %': uniqueOpenedPct,
    'total clicked': g.totalClicked || '',
    'unique clicked': g.uniqueClicked,
    'unique clicked %': uniqueClickedPct,
    'subject line or title': g.subject || '',
  };
}

function appendCampaigns_(campaigns, tabName, channelLabel, label) {
  const sheet = SpreadsheetApp.openById(CLG_SHEET_ID).getSheetByName(tabName);
  if (!sheet) { Logger.log(label + ': ERROR -- no tab named "' + tabName + '" found in the sheet.'); return; }

  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const nameColIdx = headers.findIndex(function (h) { return (h || '').toString().trim().toLowerCase() === 'campaign name'; });
  if (nameColIdx === -1) { Logger.log(label + ': ERROR -- "' + tabName + '" has no "Campaign Name" column.'); return; }

  const lastRow = sheet.getLastRow();
  const existingNames = {};
  if (lastRow > 1) {
    sheet.getRange(2, nameColIdx + 1, lastRow - 1, 1).getValues().forEach(function (r) { existingNames[r[0]] = true; });
  }

  const newOnes = campaigns.filter(function (c) { return !existingNames[c.campaignName]; });
  Logger.log(label + ': ' + campaigns.length + ' campaigns found across scanned reports, ' + newOnes.length + ' are new.');
  if (newOnes.length === 0) return;

  const rows = newOnes.map(function (g) {
    const fieldMap = buildFieldMap_(g, channelLabel);
    return headers.map(function (h) {
      const key = (h || '').toString().trim().toLowerCase();
      return Object.prototype.hasOwnProperty.call(fieldMap, key) ? fieldMap[key] : '';
    });
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
  Logger.log(label + ': appended ' + newOnes.map(function (g) { return g.campaignName; }).join(', '));
}

/**
 * Main entry point. Run this once manually first (to grant permissions), then set up
 * the daily trigger via runOneTimeSetup().
 */
function runSync() {
  Logger.log('=== EMAIL ===');
  const emailCsvs = fetchMatchingReportCsvs_('Campaign_Multi_Email_Summary', MAX_REPORTS_TO_SCAN);
  Logger.log('Matching email reports scanned: ' + emailCsvs.length);
  const emailCampaigns = aggregateCampaigns_(emailCsvs);
  appendCampaigns_(emailCampaigns, EMAIL_TAB_NAME, 'email', 'Email');

  Logger.log('=== WHATSAPP ===');
  const waCsvs = fetchMatchingReportCsvs_('Campaign_Multi_Whatsapp_Summary', MAX_REPORTS_TO_SCAN);
  Logger.log('Matching whatsapp reports scanned: ' + waCsvs.length);
  const waCampaigns = aggregateCampaigns_(waCsvs);
  appendCampaigns_(waCampaigns, WHATSAPP_TAB_NAME, 'whatsapp', 'Whatsapp');

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
