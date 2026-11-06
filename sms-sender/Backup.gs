/**
 * Berlim Homes Rent Ledger: daily backup to Google Drive.
 * Every night it copies every record in the ledger into one file in the Drive
 * folder "Berlim Homes ledger backups", and keeps the last 30 days.
 * Restore: download a backup file, then in the ledger open Admin > Import and choose it.
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
  props_().setProperty('LAST_BACKUP', new Date().toISOString() + ' | ' + n + ' records | ' + file.getName());
  try { fsFetch_(FS + '/sms/_backup?updateMask.fieldPaths=lastBackup&updateMask.fieldPaths=records&updateMask.fieldPaths=file', 'patch',
    { fields: { lastBackup: toFs_(new Date().toISOString()), records: toFs_(n), file: toFs_(file.getName()) } }); } catch (e) {}
  console.log('Backup saved: ' + file.getName() + ' (' + n + ' records)');
  return file.getUrl();
}

function setupBackup() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'backupNow').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('backupNow').timeBased().atHour(2).everyDays(1).inTimezone('Africa/Nairobi').create();
  const url = backupNow();
  console.log('Daily backup set for about 2 am. First backup: ' + url);
}
