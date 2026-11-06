/**
 * Berlim Homes Rent Ledger: daily backup to Google Drive.
 * Every night it copies every record in the ledger into one file in the Drive
 * folder "Berlim Homes ledger backups", and keeps the last 30 days.
 * Each backup also saves:
 *   - an Excel file (.xlsx), one tab per record type plus an "Invoice lines" tab, to open in Excel;
 *   - a Google Sheet "Berlim ledger backup (latest)" with the same tabs (only the newest is kept);
 *   - a Google Doc summary per property: units, occupied, billed, collected and arrears.
 * Restore: download the .json backup file, then in the ledger open Admin > Import and choose it.
 *
 * Setup (once): choose "setupBackup" at the top and press Run. Allow the permissions Google asks for.
 * Run "backupNow" any time for an extra backup.
 */
const BACKUP_FOLDER = 'Berlim Homes ledger backups';
const BACKUP_KEEP_DAYS = 30;
const BACKUP_COLS = ['properties', 'units', 'tenants', 'readings', 'invoices', 'payments', 'providers', 'pbills', 'ppays',
  'approvals', 'staff', 'accessRequests', 'remits', 'ldeds', 'linvoices', 'landlords', 'lreports', 'sms', 'maint',
  'expenses', 'people', 'logins'];

function val_(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('referenceValue' in v) return v.referenceValue;
  if ('geoPointValue' in v) return v.geoPointValue;
  if ('bytesValue' in v) return v.bytesValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(val_);
  if ('mapValue' in v) { const o = {}, f = v.mapValue.fields || {}; Object.keys(f).forEach(k => o[k] = val_(f[k])); return o; }
  return null;
}
function docObj_(d) { const o = {}, f = d.fields || {}; Object.keys(f).forEach(k => o[k] = val_(f[k])); o.id = d.name.split('/').pop(); return o; }

function readCol_(col) {
  const out = []; let token = '';
  do {
    const r = fsFetch_(FS + '/' + col + '?pageSize=300' + (token ? '&pageToken=' + encodeURIComponent(token) : ''));
    (r.documents || []).forEach(d => out.push(docObj_(d)));
    token = r.nextPageToken || '';
  } while (token);
  return out;
}

function backupFolder_() {
  const it = DriveApp.getFoldersByName(BACKUP_FOLDER);
  return it.hasNext() ? it.next() : DriveApp.createFolder(BACKUP_FOLDER);
}

function backupNow() {
  const data = { app: 'berlim-ledger', backup: true, exportedAt: new Date().toISOString(), collections: {}, settings: null };
  let n = 0;
  BACKUP_COLS.forEach(col => { try { const rows = readCol_(col); data.collections[col] = rows; n += rows.length; } catch (e) { data.collections[col] = []; console.log(col + ': ' + e.message); } });
  try { const s = fsFetch_(FS + '/settings/config'); data.settings = docObj_(s); } catch (e) { console.log('settings: ' + e.message); }
  const stamp = Utilities.formatDate(new Date(), 'Africa/Nairobi', 'yyyy-MM-dd HHmm');
  const folder = backupFolder_();
  const file = folder.createFile(Utilities.newBlob(JSON.stringify(data), 'application/json', 'berlim-ledger-backup ' + stamp + '.json'));
  // keep the last 30 days
  const cutoff = Date.now() - BACKUP_KEEP_DAYS * 864e5, old = folder.getFiles();
  while (old.hasNext()) { const f = old.next(); if (f.getDateCreated().getTime() < cutoff && /^berlim-ledger-backup /.test(f.getName())) f.setTrashed(true); }
  try { backupSheets_(data, folder, stamp); } catch (e) { console.log('Excel backup: ' + e.message); }
  try { backupDoc_(data, folder, stamp); } catch (e) { console.log('Doc summary: ' + e.message); }
  props_().setProperty('LAST_BACKUP', new Date().toISOString() + ' | ' + n + ' records | ' + file.getName());
  try { fsFetch_(FS + '/sms/_backup?updateMask.fieldPaths=lastBackup&updateMask.fieldPaths=records&updateMask.fieldPaths=file', 'patch',
    { fields: { lastBackup: toFs_(new Date().toISOString()), records: toFs_(n), file: toFs_(file.getName()) } }); } catch (e) {}
  console.log('Backup saved: ' + file.getName() + ' (' + n + ' records)');
  return file.getUrl();
}

const SHEET_NAMES = { properties: 'Properties', units: 'Units', tenants: 'Tenants', invoices: 'Invoices', payments: 'Payments',
  readings: 'Meter readings', landlords: 'Landlords', remits: 'Landlord payments', ldeds: 'Landlord deductions', lreports: 'Landlord reports',
  linvoices: 'Landlord invoices', expenses: 'Expenses', maint: 'Maintenance', providers: 'Providers', pbills: 'Provider bills',
  ppays: 'Provider payments', approvals: 'Approvals', staff: 'Staff', people: 'People', accessRequests: 'Access requests', logins: 'Logins', sms: 'SMS' };
const FIRST_COLS = ['id', 'no', 'name', 'code', 'label', 'tenantId', 'unitId', 'propertyId', 'month', 'date', 'issueDate', 'dueDate', 'total', 'amount', 'phone'];

function cell_(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') v = JSON.stringify(v);
  if (typeof v === 'string' && v.length > 45000) v = v.slice(0, 45000) + '...';
  return v;
}
function table_(rows) {
  const keys = {}; rows.forEach(r => Object.keys(r).forEach(k => keys[k] = 1));
  const cols = FIRST_COLS.filter(k => keys[k]).concat(Object.keys(keys).filter(k => FIRST_COLS.indexOf(k) < 0).sort());
  return [cols].concat(rows.map(r => cols.map(c => cell_(r[c]))));
}
function putTab_(ss, name, vals) {
  const sh = ss.insertSheet(name.slice(0, 99));
  if (!vals.length || !vals[0].length) return;
  sh.getRange(1, 1, vals.length, vals[0].length).setValues(vals);
  sh.getRange(1, 1, 1, vals[0].length).setFontWeight('bold').setBackground('#e8eef7');
  sh.setFrozenRows(1);
}

function backupSheets_(data, folder, stamp) {
  const C = data.collections;
  const ss = SpreadsheetApp.create('Berlim ledger backup ' + stamp);
  const first = ss.getSheets()[0]; first.setName('About');
  const about = [['Berlim Homes rent ledger backup'], ['Saved', stamp + ' (Nairobi time)'], ['Restore', 'Use the .json file of the same date: Admin > Import in the ledger'], [''], ['Tab', 'Records']];
  // readable tabs first
  const order = ['properties', 'units', 'tenants', 'invoices', 'payments', 'readings', 'landlords', 'remits', 'ldeds', 'lreports', 'linvoices',
    'expenses', 'maint', 'providers', 'pbills', 'ppays', 'approvals', 'staff', 'people', 'accessRequests', 'logins', 'sms'];
  order.forEach(col => {
    let rows = C[col] || [];
    if (!rows.length) return;
    if (col === 'sms') rows = rows.slice(-2000);
    putTab_(ss, SHEET_NAMES[col] || col, table_(rows));
    about.push([SHEET_NAMES[col] || col, rows.length]);
    if (col === 'invoices') {
      const lines = [['Invoice', 'Invoice no', 'Tenant', 'Unit', 'Month', 'Description', 'Qty', 'Rate', 'Amount', 'Kind', 'Reversed']];
      rows.forEach(i => (i.lines || []).forEach(l => lines.push([i.id, i.no || '', i.tenantId || '', i.unitId || '', i.month || '',
        cell_(l.desc), cell_(l.qty), cell_(l.rate), cell_(l.amount), cell_(l.kind), i.reversed ? 'yes' : ''])));
      putTab_(ss, 'Invoice lines', lines);
      about.push(['Invoice lines', lines.length - 1]);
    }
  });
  const w = Math.max.apply(null, about.map(r => r.length));
  first.getRange(1, 1, about.length, w).setValues(about.map(r => r.concat(Array(w - r.length).fill(''))));
  first.getRange(1, 1).setFontWeight('bold').setFontSize(13);
  SpreadsheetApp.flush();
  const file = DriveApp.getFileById(ss.getId());
  file.moveTo(folder);
  // Excel copy, kept 30 days like the json
  const resp = UrlFetchApp.fetch('https://docs.google.com/spreadsheets/d/' + ss.getId() + '/export?format=xlsx',
    { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
  if (resp.getResponseCode() === 200) folder.createFile(resp.getBlob().setName('berlim-ledger-backup ' + stamp + '.xlsx'));
  else console.log('xlsx export failed: ' + resp.getResponseCode());
  // only keep the newest Google Sheet; the daily Excel files hold the history
  file.setName('Berlim ledger backup (latest)');
  const it = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
  while (it.hasNext()) { const f = it.next(); if (f.getId() !== file.getId() && /^Berlim ledger backup/.test(f.getName())) f.setTrashed(true); }
}

function money_(n) { return 'KES ' + Math.round(n || 0).toLocaleString('en-US'); }

function backupDoc_(data, folder, stamp) {
  const C = data.collections, now = new Date();
  const month = Utilities.formatDate(now, 'Africa/Nairobi', 'yyyy-MM');
  const units = C.units || [], tenants = C.tenants || [], invs = (C.invoices || []).filter(i => !i.reversed), pays = C.payments || [];
  const unitProp = {}; units.forEach(u => unitProp[u.id] = u.propertyId);
  const tenProp = {}; tenants.forEach(t => tenProp[t.id] = unitProp[t.unitId] || t.propertyId || '');
  const billed = {}, paid = {}; invs.forEach(i => billed[i.tenantId] = (billed[i.tenantId] || 0) + (+i.total || 0));
  pays.forEach(p => paid[p.tenantId] = (paid[p.tenantId] || 0) + (+p.amount || 0));
  const doc = DocumentApp.create('Berlim ledger summary ' + stamp);
  const b = doc.getBody();
  b.appendParagraph('Berlim Homes Ltd: ledger summary').setHeading(DocumentApp.ParagraphHeading.HEADING1);
  b.appendParagraph('Saved ' + stamp + ' (Nairobi time). Month: ' + Utilities.formatDate(now, 'Africa/Nairobi', 'MMMM yyyy') +
    '. Figures are from the backup; the ledger is the final word.');
  const rows = [['Property', 'Units', 'Occupied', 'Billed this month', 'Collected this month', 'Tenants owing', 'Arrears (current tenants)']];
  let T = [0, 0, 0, 0, 0, 0];
  (C.properties || []).forEach(p => {
    const pu = units.filter(u => u.propertyId === p.id);
    const act = tenants.filter(t => t.active !== false && !t.moveOut && tenProp[t.id] === p.id);
    const occ = {}; act.forEach(t => occ[t.unitId] = 1);
    const bm = invs.filter(i => i.month === month && tenProp[i.tenantId] === p.id).reduce((s, i) => s + (+i.total || 0), 0);
    const cm = pays.filter(x => String(x.date || '').slice(0, 7) === month && tenProp[x.tenantId] === p.id).reduce((s, x) => s + (+x.amount || 0), 0);
    let owing = 0, arr = 0; act.forEach(t => { const bal = (billed[t.id] || 0) - (paid[t.id] || 0); if (bal > 0) { owing++; arr += bal; } });
    const r = [pu.length, Object.keys(occ).length, bm, cm, owing, arr]; r.forEach((v, k) => T[k] += v);
    rows.push([(p.code || p.id) + ' ' + (p.name || ''), String(r[0]), String(r[1]), money_(r[2]), money_(r[3]), String(r[4]), money_(r[5])]);
  });
  rows.push(['Total', String(T[0]), String(T[1]), money_(T[2]), money_(T[3]), String(T[4]), money_(T[5])]);
  const tb = b.appendTable(rows);
  tb.getRow(0).editAsText().setBold(true); tb.getRow(rows.length - 1).editAsText().setBold(true);
  b.appendParagraph('Records in this backup').setHeading(DocumentApp.ParagraphHeading.HEADING2);
  b.appendTable([['Type', 'Records']].concat(Object.keys(C).filter(k => (C[k] || []).length).map(k => [SHEET_NAMES[k] || k, String(C[k].length)])))
    .getRow(0).editAsText().setBold(true);
  doc.saveAndClose();
  DriveApp.getFileById(doc.getId()).moveTo(folder);
  const cutoff = Date.now() - BACKUP_KEEP_DAYS * 864e5, it = folder.getFilesByType(MimeType.GOOGLE_DOCS);
  while (it.hasNext()) { const f = it.next(); if (f.getDateCreated().getTime() < cutoff && /^Berlim ledger summary/.test(f.getName())) f.setTrashed(true); }
}

function setupBackup() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'backupNow').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('backupNow').timeBased().atHour(2).everyDays(1).inTimezone('Africa/Nairobi').create();
  const url = backupNow();
  console.log('Daily backup set for about 2 am. First backup: ' + url);
}
