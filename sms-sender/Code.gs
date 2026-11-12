/**
 * Berlim Homes Rent Ledger: SMS sender (Mspace).
 * Runs every minute on Google's servers. It reads texts the ledger has queued in the
 * Firestore "sms" collection, sends them through Mspace, and marks each one Sent or Failed.
 *
 * Setup (once):
 *  1. Project Settings (gear) > Script properties > add:
 *       MSPACE_USERNAME   your Mspace username
 *       MSPACE_API_KEY    from the Mspace portal: API > SMS > Generate Keys
 *       MSPACE_SENDER_ID  your approved sender ID, e.g. BERLIMHOMES
 *       TEST_PHONE        (optional) your own phone, for sendTestSms
 *  2. Choose the function "setup" at the top and press Run. Allow the permissions Google asks for.
 */

const PROJECT_ID = 'berlim-homes-ltd';
const DATABASE_ID = 'default';
const MSPACE = 'https://api.mspace.co.ke/smsapi/v2/';
const MAX_PER_RUN = 40;          // texts sent per minute at most
const EXPIRE_DAYS = 3;           // queued texts older than this are not sent (e.g. sender was off for days)

const FS = 'https://firestore.googleapis.com/v1/projects/' + PROJECT_ID + '/databases/' + DATABASE_ID + '/documents';

function props_() { return PropertiesService.getScriptProperties(); }
function creds_() {
  const p = props_();
  const c = { user: p.getProperty('MSPACE_USERNAME'), key: p.getProperty('MSPACE_API_KEY'), sender: p.getProperty('MSPACE_SENDER_ID') };
  if (!c.user || !c.key || !c.sender) throw new Error('Add MSPACE_USERNAME, MSPACE_API_KEY and MSPACE_SENDER_ID in Project Settings > Script properties.');
  return c;
}

/* ---------- Firestore (REST, signed in as the script owner) ---------- */
function fsFetch_(url, method, body) {
  const r = UrlFetchApp.fetch(url, {
    method: method || 'get', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: body ? JSON.stringify(body) : undefined
  });
  const code = r.getResponseCode(), text = r.getContentText();
  if (code >= 300) throw new Error('Firestore ' + code + ': ' + text.slice(0, 300));
  return text ? JSON.parse(text) : {};
}
function toFs_(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  return { stringValue: String(v) };
}
function fromFs_(f) {
  const o = {};
  Object.keys(f || {}).forEach(k => {
    const v = f[k];
    o[k] = 'stringValue' in v ? v.stringValue : 'integerValue' in v ? Number(v.integerValue) : 'doubleValue' in v ? v.doubleValue : 'booleanValue' in v ? v.booleanValue : null;
  });
  return o;
}
function update_(id, fields) {
  const mask = Object.keys(fields).map(k => 'updateMask.fieldPaths=' + encodeURIComponent(k)).join('&');
  const body = { fields: {} };
  Object.keys(fields).forEach(k => body.fields[k] = toFs_(fields[k]));
  return fsFetch_(FS + '/sms/' + encodeURIComponent(id) + '?' + mask, 'patch', body);
}
/* scheduled texts: status 'scheduled' with dueAt (ISO time). When the time comes they join the queue. */
function promoteDue_() {
  const now = new Date().toISOString(); let n = 0;
  const res = fsFetch_(FS + ':runQuery', 'post', { structuredQuery: {
    from: [{ collectionId: 'sms' }],
    where: { fieldFilter: { field: { fieldPath: 'dueAt' }, op: 'LESS_THAN_OR_EQUAL', value: { stringValue: now } } },
    limit: 200
  } });
  (res || []).filter(x => x.document).forEach(x => {
    const d = fromFs_(x.document.fields), id = x.document.name.split('/').pop();
    if (d.status === 'scheduled') { update_(id, { status: 'queued', dueAt: null, createdAt: now }); n++; }
    else update_(id, { dueAt: null });
  });
  return n;
}
function queued_() {
  const res = fsFetch_(FS + ':runQuery', 'post', { structuredQuery: {
    from: [{ collectionId: 'sms' }],
    where: { fieldFilter: { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: 'queued' } } },
    limit: MAX_PER_RUN
  } });
  return (res || []).filter(x => x.document).map(x => {
    const d = fromFs_(x.document.fields); d.id = x.document.name.split('/').pop(); return d;
  });
}

/* ---------- Mspace ---------- */
function xml_(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;'); }
function mspace_(path, xmlBody) {
  const c = creds_();
  const r = UrlFetchApp.fetch(MSPACE + path, {
    method: 'post', muteHttpExceptions: true, contentType: 'application/xml',
    headers: { apikey: c.key, Accept: 'application/json' }, payload: xmlBody
  });
  return { code: r.getResponseCode(), text: r.getContentText() || '' };
}
function phone_(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.startsWith('0')) d = '254' + d.slice(1); else if (d.length === 9) d = '254' + d;
  return /^254(7|1)\d{8}$/.test(d) ? d : '';
}
function sendOne_(to, text) {
  const c = creds_();
  const r = mspace_('sendtext', '<sms><username>' + xml_(c.user) + '</username><senderId>' + xml_(c.sender) + '</senderId><recipient>' + to + '</recipient><message>' + xml_(text) + '</message></sms>');
  const t = r.text, low = t.toLowerCase();
  // Mspace replies {"message":[{"messageId":"87474190","status":111,"statusDescription":"Message sent succesfully"}]}
  // errors come back as HTTP 200 too, e.g. status 100 "ERR113 - Invalid sender Id."
  let messageId = '', status = null;
  const m = t.match(/messageId"?\s*[:=]\s*"?(\w+)/i); if (m) messageId = m[1];
  const sm = t.match(/"status"\s*:\s*"?(\d+)/); if (sm) status = Number(sm[1]);
  const bad = /err\d+|fail|invalid|insufficient|denied|unauthori|not allowed|blacklist|reject/.test(low);
  const ok = r.code < 300 && !bad && !!messageId && (status === 111 || /succes/.test(low));
  return { ok, transient: r.code >= 500 || r.code === 429, code: r.code, text: t.slice(0, 300), messageId };
}
function balance_() {
  const c = creds_();
  const r = mspace_('balance', '<user><username>' + xml_(c.user) + '</username></user>');
  const n = parseInt(String(r.text).replace(/[^\d-]/g, ''), 10);
  return r.code < 300 && !isNaN(n) ? n : null;
}

/* ---------- the job that runs every minute ---------- */
function processQueue() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    const now = new Date(), status = { lastRun: now.toISOString() };
    /* Save the free daily database reads: search the message list only when the ledger has flagged
       new texts (sms/_pending), when the last run left some behind, or every 5 minutes for scheduled texts. */
    const P = props_();
    let pendingAt = '';
    try { const d = fsFetch_(FS + '/sms/_pending', 'get'); pendingAt = (fromFs_(d.fields).queuedAt) || ''; } catch (e) { pendingAt = ''; }
    let doQueue = P.getProperty('MORE') !== '0' || (pendingAt && pendingAt !== P.getProperty('LAST_PENDING'));
    if (now.getTime() - Number(P.getProperty('SCHED_AT') || 0) >= 5 * 60 * 1000) {
      P.setProperty('SCHED_AT', String(now.getTime()));
      try { if (promoteDue_() > 0) doQueue = true; } catch (e) { console.error('scheduled: ' + e); }
    }
    if (!doQueue) { try { update_('_status', { lastRun: now.toISOString(), status: 'status', kind: 'status' }); } catch (e) {} return; }
    let list = [];
    try { list = queued_(); } catch (e) { console.error(e); return; }
    if (pendingAt) P.setProperty('LAST_PENDING', pendingAt);
    let more = list.length >= MAX_PER_RUN;
    let sent = 0, failed = 0, lastError = '';
    for (const s of list) {
      if (s.id === '_status') continue;
      const age = (now - new Date(s.createdAt || now)) / 864e5;
      const to = phone_(s.to);
      if (age > EXPIRE_DAYS) { update_(s.id, { status: 'failed', error: 'Not sent: waited more than ' + EXPIRE_DAYS + ' days' }); continue; }
      if (!to) { update_(s.id, { status: 'failed', error: 'No valid phone number' }); failed++; continue; }
      update_(s.id, { status: 'sending' });
      let r;
      try { r = sendOne_(to, s.text || ''); } catch (e) { r = { ok: false, transient: true, text: String(e).slice(0, 300) }; }
      if (r.ok) { update_(s.id, { status: 'sent', sentAt: new Date().toISOString(), messageId: r.messageId, response: r.text }); sent++; }
      else {
        const tries = (Number(s.tries) || 0) + 1;
        if (r.transient && tries < 3) { update_(s.id, { status: 'queued', tries: tries, error: r.text }); more = true; }
        else { update_(s.id, { status: 'failed', tries: tries, error: r.text, response: r.text }); failed++; lastError = r.text; }
      }
    }
    P.setProperty('MORE', more ? '1' : '0');
    const p = P, lastBal = Number(p.getProperty('BAL_AT') || 0);
    if (sent || now - lastBal > 30 * 60 * 1000) {
      try { const b = balance_(); if (b !== null) { status.balance = b; status.balanceAt = now.toISOString(); } } catch (e) { lastError = lastError || String(e); }
      p.setProperty('BAL_AT', String(now.getTime()));
    }
    status.error = lastError ? lastError.slice(0, 200) : '';
    status.status = 'status'; status.kind = 'status';
    try { update_('_status', status); } catch (e) { console.error(e); }
  } finally { lock.releaseLock(); }
}

/* ---------- run once ---------- */
function setup() {
  creds_();
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'processQueue').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('processQueue').timeBased().everyMinutes(1).create();
  fsFetch_(FS + '/sms/_status', 'get');  // checks Firestore access (fails here if not allowed)
  const b = balance_();
  update_('_status', { lastRun: new Date().toISOString(), balance: b, balanceAt: new Date().toISOString(), error: b === null ? 'Could not read the SMS balance: check the Mspace username and API key' : '', status: 'status', kind: 'status' });
  console.log('Set up. Mspace SMS balance: ' + b + '. Texts will now go out within a minute of being queued.');
}

/* sends one text to TEST_PHONE so you can check your sender ID and key */
function sendTestSms() {
  const to = phone_(props_().getProperty('TEST_PHONE'));
  if (!to) throw new Error('Add TEST_PHONE (your phone number) in Script properties first.');
  const r = sendOne_(to, 'Test from the Berlim Homes rent ledger. SMS is working.');
  console.log((r.ok ? 'SENT. ' : 'NOT SENT. ') + 'Mspace replied (' + r.code + '): ' + r.text);
}

/* shows exactly what Mspace replies (for troubleshooting) */
function checkMspace() {
  const c = creds_();
  console.log('Username has ' + c.user.length + ' characters; sender ID: ' + c.sender + '; key has ' + c.key.length + ' characters');
  const a = mspace_('balance', '<user><username>' + xml_(c.user) + '</username></user>');
  console.log('POST balance -> ' + a.code + ': ' + a.text.slice(0, 300));
}
