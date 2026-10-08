// Everything the app reads from or writes to Firebase.
import {
  signInWithEmailAndPassword, createUserWithEmailAndPassword, signInAnonymously, signInWithCustomToken, signOut,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  doc, collection, query, where, orderBy, limitToLast, onSnapshot, getDoc, setDoc, updateDoc, deleteDoc,
  writeBatch, serverTimestamp, increment, arrayUnion, arrayRemove, deleteField, getCountFromServer, Timestamp,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { ref, uploadBytesResumable, getDownloadURL } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-storage.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-functions.js';
import { auth, db, storage, functions } from './fb.js';
import { EMAIL_DOMAIN } from './config.js';
import { randomId, sha256Hex, describeDevice, colorFor } from './util.js';

export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,23}$/;
export const normalizeUsername = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '.');
const emailFor = (username) => `${normalizeUsername(username)}@${EMAIL_DOMAIN}`;

// ---------- Signing in ----------

function friendlyAuthError(err) {
  const code = err?.code || '';
  if (/invalid-credential|wrong-password|user-not-found|invalid-login/.test(code)) return 'Wrong username or PIN.';
  if (/too-many-requests/.test(code)) return 'Too many wrong tries. Wait a few minutes and try again.';
  if (/email-already-in-use/.test(code)) return 'That username is taken. Pick another one, or sign in.';
  if (/weak-password/.test(code)) return 'The PIN must be at least 6 digits.';
  if (/network-request-failed/.test(code)) return 'No internet connection. Check your Wi-Fi or mobile data.';
  if (/permission-denied/.test(code)) return 'Wrong team code. Ask your department head for it.';
  return err?.message || 'Something went wrong. Try again.';
}

export async function signInWithPin(username, pin) {
  try {
    await signInWithEmailAndPassword(auth, emailFor(username), String(pin));
  } catch (err) {
    throw new Error(friendlyAuthError(err));
  }
}

export async function join({ teamCode, username, displayName, title, pin }) {
  const name = normalizeUsername(username);
  if (!USERNAME_RE.test(name)) throw new Error('Username: 3–24 letters or numbers (you can use . _ -), e.g. ali.raza');
  if (String(pin).length < 6) throw new Error('The PIN must be at least 6 digits.');
  let cred;
  try {
    cred = await createUserWithEmailAndPassword(auth, emailFor(name), String(pin));
  } catch (err) {
    throw new Error(friendlyAuthError(err));
  }
  const uid = cred.user.uid;
  const batch = writeBatch(db);
  batch.set(doc(db, `users/${uid}/private/join`), { code: String(teamCode).trim() });
  batch.set(doc(db, `users/${uid}`), {
    username: name, displayName: String(displayName).trim().slice(0, 60), title: String(title || '').trim().slice(0, 60),
    color: colorFor(name), createdAt: serverTimestamp(), lastSeen: serverTimestamp(),
  });
  try {
    await batch.commit();
  } catch (err) {
    // Wrong team code: remove the half-made account so the username stays free.
    await cred.user.delete().catch(() => signOut(auth));
    throw new Error(friendlyAuthError(err));
  }
}

export const signOutHere = () => signOut(auth);

// ---------- Link a computer with a QR code ----------

/**
 * Computer side. Shows a fresh QR every minute; when a phone approves, signs in as that
 * person. onUpdate({ qr, expiresAt } | { status: 'approved' | 'error', message }).
 */
export function startLinkAsComputer(onUpdate) {
  let stopped = false;
  let unsub = null;
  let timer = null;
  let current = null;

  const cleanup = async () => {
    if (unsub) unsub();
    unsub = null;
    clearTimeout(timer);
    if (current) await deleteDoc(doc(db, `links/${current}`)).catch(() => {});
    current = null;
  };

  async function round() {
    if (stopped) return;
    await cleanup();
    try {
      if (!auth.currentUser || !auth.currentUser.isAnonymous) await signInAnonymously(auth);
      const id = randomId(15);
      const code = randomId(12);
      await setDoc(doc(db, `links/${id}`), {
        pc: auth.currentUser.uid, codeHash: await sha256Hex(code), device: describeDevice(),
        createdAt: serverTimestamp(), status: 'pending',
      });
      if (stopped) { await deleteDoc(doc(db, `links/${id}`)).catch(() => {}); return; }
      current = id;
      onUpdate({ qr: `${location.origin}/link#${id}.${code}`, expiresAt: Date.now() + 60_000 });
      unsub = onSnapshot(doc(db, `links/${id}`), async (snap) => {
        const d = snap.data();
        if (!d || d.status !== 'approved' || !d.token || stopped) return;
        stopped = true;
        const token = d.token;
        const by = d.by || 'phone';
        await cleanup();
        try {
          sessionStorage.setItem('mm.via', JSON.stringify({ via: 'qr', by }));
        } catch { /* storage unavailable */ }
        onUpdate({ status: 'approved' });
        try {
          await signInWithCustomToken(auth, token);
        } catch (err) {
          onUpdate({ status: 'error', message: friendlyAuthError(err) });
        }
      });
      timer = setTimeout(round, 58_000);
    } catch (err) {
      onUpdate({ status: 'error', message: friendlyAuthError(err) });
      timer = setTimeout(round, 8_000);
    }
  }
  round();
  return async () => { stopped = true; await cleanup(); };
}

/** Phone side: reads the QR text ("…/link#<id>.<code>"). */
export function parseLinkCode(text) {
  const m = /\/link#([A-Za-z0-9_-]{10,40})\.([A-Za-z0-9_-]{8,40})/.exec(String(text || ''));
  return m ? { id: m[1], code: m[2] } : null;
}

export async function peekLink(id) {
  const snap = await getDoc(doc(db, `links/${id}`)).catch(() => null);
  if (!snap || !snap.exists()) throw new Error('This QR code has expired. Scan the new code on the computer.');
  return snap.data();
}

export async function approveLink(id, code) {
  try {
    const res = await httpsCallable(functions, 'approveLink')({ id, code, device: describeDevice() });
    return res.data;
  } catch (err) {
    throw new Error(err.message || 'Could not link the device. Try again.');
  }
}

// ---------- Live data ----------

const watch = (q, cb, onErr) => onSnapshot(q, cb, (err) => { console.warn(err); onErr && onErr(err); });

export const watchUsers = (cb) => watch(collection(db, 'users'), (s) => cb(s.docs.map((d) => ({ uid: d.id, ...d.data() }))));
export const watchMyConvs = (uid, cb) =>
  watch(query(collection(db, 'convs'), where('members', 'array-contains', uid), orderBy('updatedAt', 'desc')), (s) => cb(s));
export const watchChannels = (cb) =>
  watch(query(collection(db, 'convs'), where('type', '==', 'channel'), orderBy('name')), (s) => cb(s));
export const watchReadState = (uid, cb) => watch(doc(db, `users/${uid}/state/reads`), (s) => cb(s.data() || {}));
export const watchMsgs = (cid, n, cb) =>
  watch(query(collection(db, `convs/${cid}/msgs`), orderBy('ts'), limitToLast(n)), (s) => cb(s));
export const watchReplies = (cid, mid, cb) =>
  watch(query(collection(db, `convs/${cid}/msgs/${mid}/replies`), orderBy('ts')), (s) => cb(s));
export const watchMsg = (cid, mid, cb) => watch(doc(db, `convs/${cid}/msgs/${mid}`), (s) => cb(s));
export const watchConvReads = (cid, cb) =>
  watch(collection(db, `convs/${cid}/reads`), (s) => { const o = {}; s.forEach((d) => { o[d.id] = d.get('ts'); }); cb(o); });
export const watchTyping = (cid, cb) =>
  watch(collection(db, `convs/${cid}/typing`), (s) => { const o = {}; s.forEach((d) => { o[d.id] = d.get('ts'); }); cb(o); });
export const watchDevices = (uid, cb) => watch(collection(db, `users/${uid}/devices`), (s) => cb(s.docs.map((d) => ({ id: d.id, ...d.data() }))));
export const watchDevice = (uid, did, cb) => watch(doc(db, `users/${uid}/devices/${did}`), (s) => cb(s));

export async function unreadCount(cid, since) {
  const q = since
    ? query(collection(db, `convs/${cid}/msgs`), where('ts', '>', since))
    : collection(db, `convs/${cid}/msgs`);
  const res = await getCountFromServer(q);
  return res.data().count;
}

// ---------- Conversations ----------

export const dmId = (a, b) => `dm_${[a, b].sort().join('_')}`;

export async function ensureDm(me, other) {
  const id = dmId(me, other);
  const snap = await getDoc(doc(db, `convs/${id}`));
  if (!snap.exists()) {
    await setDoc(doc(db, `convs/${id}`), {
      type: 'dm', members: [me, other].sort(), createdBy: me, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    });
  }
  return id;
}

export async function createGroup(me, name, members) {
  const id = `g_${randomId(10)}`;
  await setDoc(doc(db, `convs/${id}`), {
    type: 'group', name: name.trim().slice(0, 60), members: [...new Set([me, ...members])], createdBy: me,
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    last: { text: 'Group created', from: me, kind: 'system', ts: serverTimestamp() },
  });
  return id;
}

export const channelSlug = (s) => String(s || '').toLowerCase().trim().replace(/^#/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

export async function createChannel(me, name, topic) {
  const slug = channelSlug(name);
  if (slug.length < 2) throw new Error('Channel name: at least 2 letters, e.g. promo or news-desk');
  const id = `c_${slug}`;
  const existing = await getDoc(doc(db, `convs/${id}`));
  if (existing.exists()) throw new Error(`#${slug} already exists.`);
  await setDoc(doc(db, `convs/${id}`), {
    type: 'channel', name: slug, topic: String(topic || '').trim().slice(0, 200), members: [me], createdBy: me,
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  });
  return id;
}

export const joinChannel = (cid, me) => updateDoc(doc(db, `convs/${cid}`), { members: arrayUnion(me) });
export const leaveChannel = (cid, me) => updateDoc(doc(db, `convs/${cid}`), { members: arrayRemove(me) });
export const setPinned = (cid, text) => updateDoc(doc(db, `convs/${cid}`), { pinned: text ? String(text).slice(0, 300) : deleteField() });
export const renameConv = (cid, name, topic) => updateDoc(doc(db, `convs/${cid}`), { name, ...(topic != null ? { topic } : {}) });

// ---------- Messages ----------

export function snippet(m) {
  if (!m) return '';
  if (m.deleted) return 'This message was deleted';
  if (m.kind === 'system') return m.text || '';
  if (m.kind === 'voice') return '🎤 Voice message';
  if (m.kind === 'image') return `📷 ${m.text || 'Photo'}`;
  if (m.kind === 'file') return `📎 ${m.file?.name || 'File'}`;
  return String(m.text || '').slice(0, 140);
}

function buildMsg(me, { kind = 'text', text = '', file = null, reply = null, mentions = [] }) {
  const m = { from: me, ts: serverTimestamp(), kind };
  if (text) m.text = String(text).slice(0, 8000);
  if (file) m.file = file;
  if (reply) m.reply = reply;
  if (mentions.length) m.mentions = mentions.slice(0, 50);
  return m;
}

export async function sendMessage(cid, me, content) {
  const m = buildMsg(me, content);
  const msgRef = doc(collection(db, `convs/${cid}/msgs`));
  const batch = writeBatch(db);
  batch.set(msgRef, m);
  batch.update(doc(db, `convs/${cid}`), {
    last: { text: snippet(m), from: me, kind: m.kind, ts: serverTimestamp(), id: msgRef.id },
    updatedAt: serverTimestamp(),
  });
  await batch.commit();
  return msgRef.id;
}

export async function sendReply(cid, mid, me, content) {
  const m = buildMsg(me, content);
  const batch = writeBatch(db);
  batch.set(doc(collection(db, `convs/${cid}/msgs/${mid}/replies`)), m);
  batch.update(doc(db, `convs/${cid}/msgs/${mid}`), { threadCount: increment(1), threadLast: serverTimestamp(), threadUsers: arrayUnion(me) });
  await batch.commit();
}

export const react = (path, me, emoji) => updateDoc(doc(db, path), { [`reactions.${me}`]: emoji || deleteField() });
export const deleteMsg = (path) => updateDoc(doc(db, path), { deleted: true, text: '', file: null });
export const editMsg = (path, text) => updateDoc(doc(db, path), { text: String(text).slice(0, 8000), edited: serverTimestamp() });

let lastRead = {};
export async function markRead(cid, me) {
  if (Date.now() - (lastRead[cid] || 0) < 2500) return;
  lastRead[cid] = Date.now();
  await Promise.all([
    setDoc(doc(db, `convs/${cid}/reads/${me}`), { ts: serverTimestamp() }),
    setDoc(doc(db, `users/${me}/state/reads`), { [cid]: serverTimestamp() }, { merge: true }),
  ]).catch(() => {});
}

let lastTyping = 0;
export function setTyping(cid, me) {
  if (Date.now() - lastTyping < 3000) return;
  lastTyping = Date.now();
  setDoc(doc(db, `convs/${cid}/typing/${me}`), { ts: serverTimestamp() }).catch(() => {});
}

export const heartbeat = (me) => updateDoc(doc(db, `users/${me}`), { lastSeen: serverTimestamp() }).catch(() => {});
export const updateProfile = (me, displayName, title) => updateDoc(doc(db, `users/${me}`), { displayName, title });

// ---------- Devices ----------

export function deviceId() {
  try {
    let id = localStorage.getItem('mm.deviceId');
    if (!id) { id = randomId(12); localStorage.setItem('mm.deviceId', id); }
    return id;
  } catch {
    return 'browser';
  }
}

export async function registerDevice(me, did, extra = {}) {
  const ref = doc(db, `users/${me}/devices/${did}`);
  const snap = await getDoc(ref).catch(() => null);
  const data = { name: describeDevice(), platform: /MadaniMessenger/.test(navigator.userAgent) ? 'android' : 'web', lastActive: serverTimestamp(), ...extra };
  if (!snap || !snap.exists()) data.createdAt = serverTimestamp();
  await setDoc(ref, data, { merge: true });
}
export const removeDevice = (me, did) => deleteDoc(doc(db, `users/${me}/devices/${did}`));

// ---------- Files ----------

export function uploadFile(cid, file, onProgress, nameOverride) {
  const name = (nameOverride || file.name || 'file').replace(/[\\/:*?"<>|#\[\]]+/g, '_').slice(0, 120);
  const path = `files/${cid}/${randomId(9)}/${name}`;
  const task = uploadBytesResumable(ref(storage, path), file, { contentType: file.type || 'application/octet-stream' });
  const promise = new Promise((resolve, reject) => {
    task.on('state_changed', (s) => onProgress && onProgress(s.bytesTransferred / Math.max(1, s.totalBytes)), reject,
      () => resolve({ path, name, size: file.size, type: file.type || 'application/octet-stream' }));
  });
  return { promise, cancel: () => task.cancel() };
}

const urlCache = new Map();
export function fileUrl(path) {
  if (!urlCache.has(path)) urlCache.set(path, getDownloadURL(ref(storage, path)).catch((e) => { urlCache.delete(path); throw e; }));
  return urlCache.get(path);
}

export { Timestamp };
