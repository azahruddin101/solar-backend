/**
 * Solar CRM -> your Google Sheet.
 *
 * The CRM puts your company's secret in below when you copy this from Lead integrations > Google Sheet.
 * In your sheet: Extensions > Apps Script, replace everything with this, save, then
 * Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone) and paste the Web app URL in the CRM.
 */
const SECRET = '{{SECRET}}';
const SHEET_NAME = 'Leads';

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!body.secret || body.secret !== SECRET) return reply({ ok: false, error: 'Wrong secret' });
    if (!Array.isArray(body.values) || !body.values.length) return reply({ ok: false, error: 'No rows sent' });

    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      writeLeads(body.values);
    } finally {
      lock.releaseLock();
    }
    return reply({ ok: true, count: body.values.length - 1 });
  } catch (error) {
    return reply({ ok: false, error: String(error && error.message ? error.message : error) });
  }
}

// Open the web app URL in a browser to check the deployment is live.
function doGet() {
  return reply({ ok: true, message: 'Your leads sheet is ready' });
}

function writeLeads(values) {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  if (!book) throw new Error('Open Apps Script from the sheet itself (Extensions > Apps Script)');
  const sheet = book.getSheetByName(SHEET_NAME) || book.insertSheet(SHEET_NAME);
  const width = values[0].length;

  sheet.clearContents();
  const range = sheet.getRange(1, 1, values.length, width);
  range.setNumberFormat('@'); // keep phones and dates exactly as sent
  range.setValues(values);

  sheet.getRange(1, 1, 1, width).setFontWeight('bold').setBackground('#d9eee0');
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, width);
}

function reply(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}
