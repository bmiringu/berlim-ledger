/* Connects the Berlim Homes Rent Ledger to Firebase: sign-in, records (Firestore), uploads (Storage) and downloads.
   It gives the ledger the same small interface it used inside Claude, so the ledger code itself is unchanged. */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, sendPasswordResetEmail, createUserWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, doc, setDoc, deleteDoc, onSnapshot, writeBatch, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
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
const auth = getAuth(app), fs = FIRESTORE_DB === "(default)" ? getFirestore(app) : getFirestore(app, FIRESTORE_DB), st = STORAGE_ON ? getStorage(app) : null;
const adminList = ADMIN_EMAILS.map(e => e.toLowerCase());
const mapErr = e => { const c = (e && e.code) || ""; const x = new Error(e && e.message || c); x.code = c === "permission-denied" ? "invalid_argument" : c.includes("quota") || c === "resource-exhausted" ? "quota_exceeded" : c; throw x; };
const wrapQ = s => ({ docs: s.docs.map(d => ({ id: d.id, data: () => d.data() })), metadata: { fromCache: s.metadata.fromCache } });
const segs = path => path.split("/").filter(Boolean);

const db = {
  collection(c) {
    return {
      doc(id) { const r = doc(fs, c, id); return { set: o => setDoc(r, o).catch(mapErr), delete: () => deleteDoc(r).catch(mapErr) }; },
      onSnapshot(next, err) { return onSnapshot(collection(fs, c), s => next(wrapQ(s)), e => err && err(e)); }
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

let started = false;
onAuthStateChanged(auth, async u => {
  if (!u) { if (started) { location.reload(); return; } showLogin(true); return; }
  if (started) return;
  started = true; say("Opening your records…");
  const email = (u.email || "").toLowerCase();
  let staff = null;
  const slow = setTimeout(() => { showLogin(true); say("Can't reach the records database. Check your internet, then reload the page.", true); }, 20000);
  try { const d = await getDoc(doc(fs, "staff", u.uid)); staff = d.exists() ? d.data() : null; } catch (e) { staff = null; }
  clearTimeout(slow);
  const isAdmin = adminList.includes(email) || (!!staff && staff.active !== false && staff.role === "admin");
  const active = !!staff && staff.active !== false;
  try { await setDoc(doc(fs, "people", u.uid), { email: u.email, name: (staff && staff.label) || u.displayName || "", lastLogin: new Date().toISOString() }, { merge: true }); } catch (e) {}
  watchPeople();
  showLogin(false);
  const bar = $("fbUser"); bar.hidden = false; $("fbWho").textContent = (staff && staff.label) || u.email;
  window.__fbResolve({ db, user: makeUser(u, isAdmin, active), assets: STORAGE_ON && (isAdmin || active) ? assets : null, downloads, mcp: null });
});

$("fbForm").addEventListener("submit", async e => {
  e.preventDefault(); say("Signing in…");
  const email = $("fbEmail").value.trim(), pw = $("fbPass").value;
  try { await signInWithEmailAndPassword(auth, email, pw); }
  catch (x) { const c = (x && x.code) || ""; say(c.includes("too-many-requests") ? "Too many attempts. Wait a few minutes, or reset your password." : c.includes("network") ? "No internet connection. Check your data or Wi-Fi." : "Wrong email or password.", true); }
});
$("fbForgot").addEventListener("click", async () => {
  const email = $("fbEmail").value.trim(); if (!email) { say("Type your email first, then press Forgot password.", true); return; }
  try { await sendPasswordResetEmail(auth, email); say("If that email has a login, a reset link is on its way. Check the inbox and spam folder."); }
  catch (x) { say("Couldn't send the reset email. Check the address.", true); }
});
$("fbOut").addEventListener("click", () => signOut(auth));
