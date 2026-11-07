/* Connects the Berlim Homes Rent Ledger to Firebase: sign-in, records (Firestore), uploads (Storage) and downloads.
   It gives the ledger the same small interface it used inside Claude, so the ledger code itself is unchanged. */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, sendPasswordResetEmail, createUserWithEmailAndPassword, setPersistence, browserSessionPersistence } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, initializeFirestore, persistentLocalCache, persistentMultipleTabManager, memoryLocalCache, terminate, clearIndexedDbPersistence, collection, doc, setDoc, deleteDoc, onSnapshot, writeBatch, getDoc, getDocFromCache, getDocs, query, orderBy, limit, where } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getStorage, ref, uploadBytes, getDownloadURL, deleteObject } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import * as CFG from "./config.js";
const { FIREBASE_CONFIG, ADMIN_EMAILS, STORAGE_ON } = CFG;
const FIRESTORE_DB = CFG.FIRESTORE_DB || "(default)";

const $ = id => document.getElementById(id);
const showLogin = on => { $("fbLogin").hidden = !on; document.body.classList.toggle("fb-locked", on); };
const say = (msg, bad) => { const m = $("fbMsg"); m.textContent = msg || ""; m.className = bad ? "fb-msg bad" : "fb-msg"; };

if (String(FIREBASE_CONFIG.apiKey).startsWith("PASTE")) {
  showLogin(true); say("Setup isn't finished: add the Firebase apiKey and appId to config.js.", true);
  $("fbForm").querySelectorAll("input,button").forEach(x => x.disabled = true);
  throw new Error("Firebase config incomplete");
}

const app = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(app);
/* security: a login lasts only while the browser is open (closing it signs out) */
const persistReady = setPersistence(auth, browserSessionPersistence).catch(() => {});
/* speed on phones: keep a copy of the records on this device (opens instantly next time, only changes are downloaded)
   and fall back to a slower but steadier connection on networks that block streaming. The copy stays locked behind the sign-in screen
   after sign-out (so signing back in only downloads changes) and is wiped when a different person signs in on this device. */
const fsOpts = { experimentalAutoDetectLongPolling: true, localCache: (() => { try { return persistentLocalCache({ tabManager: persistentMultipleTabManager() }); } catch (e) { return memoryLocalCache(); } })() };
const fs = (() => { try { return FIRESTORE_DB === "(default)" ? initializeFirestore(app, fsOpts) : initializeFirestore(app, fsOpts, FIRESTORE_DB); } catch (e) { return FIRESTORE_DB === "(default)" ? getFirestore(app) : getFirestore(app, FIRESTORE_DB); } })(), st = STORAGE_ON ? getStorage(app) : null;
const adminList = ADMIN_EMAILS.map(e => e.toLowerCase());
const mapErr = e => { const c = (e && e.code) || ""; const x = new Error(e && e.message || c); x.code = c === "permission-denied" ? "invalid_argument" : c.includes("quota") || c === "resource-exhausted" ? "quota_exceeded" : c; throw x; };
const wrapQ = s => ({ docs: s.docs.map(d => ({ id: d.id, data: () => d.data() })), metadata: { fromCache: s.metadata.fromCache } });
const SMS_DAYS = 60;
const segs = path => path.split("/").filter(Boolean);

const db = {
  collection(c) {
    return {
      doc(id) { const r = doc(fs, c, id); return { set: o => setDoc(r, o).catch(mapErr), delete: () => deleteDoc(r).catch(mapErr) }; },
      onSnapshot(next, err) {
        if (c !== "sms") return onSnapshot(collection(fs, c), s => next(wrapQ(s)), e => err && err(e));
        // SMS history grows every day: load only the last 60 days, plus the sender's status record
        const from = new Date(Date.now() - SMS_DAYS * 864e5).toISOString();
        let recent = null, status = null;
        const emit = () => { if (!recent) return; const ds = recent.docs.filter(x => x.id !== "_status"); next({ docs: status ? ds.concat([status]) : ds, metadata: recent.metadata }); };
        const u1 = onSnapshot(query(collection(fs, "sms"), where("createdAt", ">=", from)), s => { recent = wrapQ(s); emit(); }, e => err && err(e));
        const u2 = onSnapshot(doc(fs, "sms", "_status"), d => { status = d.exists() ? { id: "_status", data: () => d.data() } : null; emit(); }, () => {});
        return () => { u1(); u2(); };
      }
    };
  },
  doc(path) {
    const r = doc(fs, ...segs(path));
    return {
      set: o => setDoc(r, o).catch(mapErr),
      onSnapshot(next, err) { return onSnapshot(r, d => next({ exists: d.exists(), data: () => d.data(), metadata: { fromCache: d.metadata.fromCache } }), e => err && err(e)); }
    };
  }
};

const MIME = { html: "text/html", csv: "text/csv", json: "application/json", pdf: "application/pdf", txt: "text/plain" };
const downloads = {
  async save({ filename, data }) {
    const ext = String(filename).split(".").pop().toLowerCase();
    const blob = data instanceof Blob ? data : new Blob([data], { type: (MIME[ext] || "application/octet-stream") + ";charset=utf-8" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }
};

const rid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
async function putFile(path, data, type) {
  const r = ref(st, path);
  await uploadBytes(r, data instanceof Blob ? data : new Blob([data], { type }), { contentType: type });
  return getDownloadURL(r);
}
const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "application/pdf": "pdf" };
const assets = {
  async upload(blob, opts = {}) {
    const type = opts.type || blob.type || "application/octet-stream";
    if (blob.size > 20 * 1024 * 1024) { const e = new Error("too large"); e.code = "too_large"; throw e; }
    if (!EXT[type]) { const e = new Error("unsupported"); e.code = "unsupported_type"; throw e; }
    const url = await putFile(`uploads/${new Date().toISOString().slice(0, 7)}/${rid()}.${EXT[type]}`, blob, type);
    return { id: url, url, sizeBytes: blob.size, contentType: type };
  },
  async delete(id) { try { await deleteObject(ref(st, id)); return { deleted: true }; } catch (e) { return { deleted: false }; } },
  async list() { return { assets: [], usage: {} }; }
};
if (STORAGE_ON) window.fbShare = (path, bytes, type) => putFile(path, bytes, type);

window.fbImport = async (data, progress) => {
  const items = [];
  for (const [col, rows] of Object.entries(data.collections || {})) {
    if (col === "accessRequests") continue;
    for (const r of rows || []) if (r && r.id) items.push([col, r]);
  }
  const total = items.length + (data.settings ? 1 : 0); let done = 0;
  for (let i = 0; i < items.length; i += 400) {
    const b = writeBatch(fs);
    for (const [col, r] of items.slice(i, i + 400)) b.set(doc(fs, col, String(r.id)), JSON.parse(JSON.stringify(r)));
    await b.commit(); done += Math.min(400, items.length - i); progress && progress(done, total);
  }
  if (data.settings && !data.kind) { await setDoc(doc(fs, "settings", "config"), JSON.parse(JSON.stringify(data.settings)), { merge: true }); done++; progress && progress(done, total); }
  for (const [col, rows] of Object.entries(data.merge || {})) for (const r of rows || []) if (r && r.id) { try { await setDoc(doc(fs, col, String(r.id)), JSON.parse(JSON.stringify(r)), { merge: true }); done++; } catch (e) {} }
  for (const [col, id] of data.deletes || []) { try { await deleteDoc(doc(fs, col, String(id))); done++; } catch (e) {} }
  return done;
};

/* people: each signed-in person keeps their own name/email so others see who did what */
let people = {};
function watchPeople() { onSnapshot(collection(fs, "people"), s => { people = {}; s.docs.forEach(d => people[d.id] = d.data()); }, () => {}); }

let secondary = null;
async function createAccount(email, password) {
  // a second app instance creates the login without signing the admin out
  secondary = secondary || initializeApp(FIREBASE_CONFIG, "staff-creator");
  const a2 = getAuth(secondary);
  const cred = await createUserWithEmailAndPassword(a2, email, password);
  const id = cred.user.uid;
  try { await setDoc(doc(fs, "people", id), { email, name: "" }); } catch (e) { /* written on their first login instead */ }
  await signOut(a2);
  return id;
}

function makeUser(u, isAdmin, active) {
  const me = { id: u.uid, name: u.displayName || "", email: u.email, isOwner: isAdmin, canEdit: isAdmin, avatarUrl: "", color: "#0F1E3A" };
  return {
    isOwner: async () => isAdmin, canEdit: async () => isAdmin,
    can: async n => n === "data.write" ? (isAdmin || active) : n === "assets.write" ? (isAdmin || active) : false,
    id: async () => u.uid, me: async () => me, email: async () => u.email, name: async () => me.name,
    profiles: async ids => { const o = {}; [].concat(ids).forEach(id => { const p = people[id] || {}; o[id] = { id, name: p.name || "", email: p.email || null, isMe: id === u.uid, guest: false, avatarUrl: "", color: "#0F1E3A" }; }); return o; },
    search: async () => [],
    createAccount: isAdmin ? createAccount : null
  };
}

/* ===================== security ===================== */
const IDLE_MS = (CFG.IDLE_MINUTES || 3) * 60 * 1000, WARN_MS = Math.min(30 * 1000, IDLE_MS / 3), LAST = "bh_last_activity", LAST_UID = "bh_last_uid";
let lastLocal = Date.now(), idleTimer = null, warnBox = null, signingOut = false;
const bc = ("BroadcastChannel" in window) ? new BroadcastChannel("bh-activity") : null;
const lastShared = () => { try { return Math.max(lastLocal, +localStorage.getItem(LAST) || 0); } catch (e) { return lastLocal; } };
function touch() {
  const now = Date.now(); if (now - lastLocal < 1000) return; lastLocal = now;
  try { localStorage.setItem(LAST, String(now)); } catch (e) {}
  if (bc) bc.postMessage(now);
  if (warnBox) hideWarn();
}
if (bc) bc.onmessage = e => { lastLocal = Math.max(lastLocal, +e.data || 0); if (warnBox) hideWarn(); if (e.data === "signout") secureSignOut("elsewhere"); };
function showWarn(secs) {
  if (!warnBox) {
    warnBox = document.createElement("div"); warnBox.id = "fbIdle";
    warnBox.innerHTML = '<div class="fb-card" role="alertdialog" aria-live="assertive"><div class="wm" style="font-size:20px">Still there?</div><p id="fbIdleMsg" style="margin:10px 0 16px"></p><button type="button" class="go" id="fbStay">Stay signed in</button></div>';
    document.body.appendChild(warnBox); document.getElementById("fbStay").onclick = () => { lastLocal = 0; touch(); };
  }
  document.getElementById("fbIdleMsg").textContent = "For security, you'll be signed out in " + secs + " second" + (secs === 1 ? "" : "s") + " because there's been no activity.";
}
function hideWarn() { if (warnBox) { warnBox.remove(); warnBox = null; } }
function logEvent(u, event) {
  if (!u) return Promise.resolve();
  const id = new Date().toISOString().replace(/[:.]/g, "-") + "-" + u.uid.slice(0, 6);
  const ua = navigator.userAgent, dev = /Android/i.test(ua) ? "Android phone" : /iPhone|iPad/i.test(ua) ? "iPhone/iPad" : /Windows/i.test(ua) ? "Windows computer" : /Mac/i.test(ua) ? "Mac" : /Linux/i.test(ua) ? "Linux computer" : "Other device";
  const br = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "";
  return setDoc(doc(fs, "logins", id), { uid: u.uid, email: u.email || "", event, at: new Date().toISOString(), device: dev + (br ? " · " + br : "") }).catch(() => {});
}
async function secureSignOut(reason) {
  if (signingOut) return; signingOut = true;
  try { sessionStorage.setItem("bh_out_reason", reason || ""); } catch (e) {}
  if (reason !== "elsewhere" && bc) bc.postMessage("signout");
  await logEvent(auth.currentUser, reason === "idle" ? "signed out: no activity" : "signed out");
  // hide the records at once, then sign out and reload so nothing stays in memory
  document.body.classList.add("fb-locked"); hideWarn();
  try { await signOut(auth); } catch (e) {}
  // the copy of the records on this device stays locked behind the sign-in screen; it is wiped if someone else signs in here
  try { await terminate(fs); } catch (e) {}
  location.reload();
}
function checkIdle() {
  if (!auth.currentUser || signingOut) return;
  const idle = Date.now() - lastShared();
  if (idle >= IDLE_MS) secureSignOut("idle");
  else if (idle >= IDLE_MS - WARN_MS) showWarn(Math.ceil((IDLE_MS - idle) / 1000));
}
function startIdleWatch() {
  ["mousemove", "mousedown", "keydown", "touchstart", "scroll", "wheel", "input", "focus"].forEach(ev => window.addEventListener(ev, touch, { passive: true, capture: true }));
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkIdle(); });
  clearInterval(idleTimer); idleTimer = setInterval(checkIdle, 1000);
}
// failed-login lock: 5 wrong passwords on this device = wait 5 minutes
const FAILS = "bh_login_fails";
const fails = () => { try { return JSON.parse(localStorage.getItem(FAILS) || "{}"); } catch (e) { return {}; } };
function lockedFor() { const f = fails(); return f.until && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 60000) : 0; }
function noteFail() { const f = fails(), n = (f.n || 0) + 1; const o = n >= 5 ? { n: 0, until: Date.now() + 5 * 60 * 1000 } : { n }; try { localStorage.setItem(FAILS, JSON.stringify(o)); } catch (e) {} return o.until ? 0 : 5 - n; }
function clearFails() { try { localStorage.removeItem(FAILS); } catch (e) {} }
window.fbRecentLogins = async (n = 60) => { const q = await getDocs(query(collection(fs, "logins"), orderBy("at", "desc"), limit(n))); return q.docs.map(d => d.data()); };
window.fbSignOutNow = () => secureSignOut("manual");

let started = false;
onAuthStateChanged(auth, async u => {
  if (!u) { if (started) { location.reload(); return; } showLogin(true);
    try { const r = sessionStorage.getItem("bh_out_reason"); if (r) { sessionStorage.removeItem("bh_out_reason"); say(r === "idle" ? "You were signed out after " + Math.round(IDLE_MS / 60000) + " minutes without activity. Sign in again to continue." : r === "elsewhere" ? "You signed out in another tab." : "You have signed out."); } } catch (e) {}
    return; }
  if (started) return;
  // a remembered session that has been idle too long (e.g. tab reopened later) is signed out straight away
  const prev = (() => { try { return +localStorage.getItem(LAST) || 0; } catch (e) { return 0; } })();
  if (!window.__justSignedIn && prev && Date.now() - prev > IDLE_MS) { await secureSignOut("idle"); return; }
  // a different person on this device: wipe the previous person's saved copy first
  try { const last = localStorage.getItem(LAST_UID); if (last && last !== u.uid) await clearIndexedDbPersistence(fs); localStorage.setItem(LAST_UID, u.uid); } catch (e) {}
  started = true; say("Opening your records…"); lastLocal = 0; touch();
  if (window.__justSignedIn) logEvent(u, "signed in");
  const email = (u.email || "").toLowerCase();
  let staff = null;
  const slow = setTimeout(() => { showLogin(true); say("Can't reach the records database. Check your internet, then reload the page.", true); }, 20000);
  // on a slow phone connection, use this device's saved copy of the team list after 5 seconds instead of waiting
  const sref = doc(fs, "staff", u.uid);
  const viaCache = new Promise(res => setTimeout(() => getDocFromCache(sref).then(res, () => {}), 5000));
  try { const d = await Promise.race([getDoc(sref), viaCache]); staff = d && d.exists() ? d.data() : null; } catch (e) { staff = null; }
  clearTimeout(slow);
  const isAdmin = adminList.includes(email) || (!!staff && staff.active !== false && staff.role === "admin");
  const active = !!staff && staff.active !== false;
  setDoc(doc(fs, "people", u.uid), { email: u.email, name: (staff && staff.label) || u.displayName || "", lastLogin: new Date().toISOString() }, { merge: true }).catch(() => {});
  watchPeople();
  showLogin(false);
  const bar = $("fbUser"); bar.hidden = false; $("fbWho").textContent = (staff && staff.label) || u.email;
  startIdleWatch();
  window.__fbResolve({ db, user: makeUser(u, isAdmin, active), assets: STORAGE_ON && (isAdmin || active) ? assets : null, downloads, mcp: null });
});

$("fbForm").addEventListener("submit", async e => {
  e.preventDefault();
  const lk = lockedFor(); if (lk) { say("Too many wrong passwords. Try again in " + lk + " minute" + (lk > 1 ? "s" : "") + ", or use Forgot password.", true); return; }
  say("Signing in…");
  const email = $("fbEmail").value.trim(), pw = $("fbPass").value;
  try { await persistReady; window.__justSignedIn = true; await signInWithEmailAndPassword(auth, email, pw); clearFails(); $("fbPass").value = ""; }
  catch (x) { window.__justSignedIn = false; const c = (x && x.code) || ""; const left = c.includes("network") || c.includes("too-many") ? null : noteFail();
    say(c.includes("too-many-requests") ? "Too many attempts. Wait a few minutes, or reset your password." : c.includes("network") ? "No internet connection. Check your data or Wi-Fi." : left === 0 ? "Too many wrong passwords. Sign-in is locked on this device for 5 minutes." : "Wrong email or password." + (left != null && left <= 2 ? " " + left + " more tr" + (left === 1 ? "y" : "ies") + " before a 5-minute lock." : ""), true); }
});
$("fbForgot").addEventListener("click", async () => {
  const email = $("fbEmail").value.trim(); if (!email) { say("Type your email first, then press Forgot password.", true); return; }
  try { await sendPasswordResetEmail(auth, email); say("If that email has a login, a reset link is on its way. Check the inbox and spam folder."); }
  catch (x) { say("Couldn't send the reset email. Check the address.", true); }
});
$("fbOut").addEventListener("click", () => secureSignOut("manual"));
