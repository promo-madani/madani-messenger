// Madani Messenger — the app: sign-in, chats, channels, threads, devices.
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { auth, db, usingEmulators } from './fb.js';
import { APP_NAME } from './config.js';
import * as D from './data.js';
import {
  ic, esc, $, ms, fmtTime, dayLabel, listTime, lastSeenText, isOnline, fmtSize, fmtDur, describeDevice,
  isPhoneDevice, initials, colorFor, isRtl,
} from './util.js';

const native = window.MadaniNative || null; // provided by the Android app
const wide = matchMedia('(min-width: 900px)');
const EMOJI = ['👍', '❤️', '🤲', '✅', '😂', '😮'];

// ---------- State ----------
const S = {
  uid: null,
  users: new Map(),          // uid -> profile
  myConvs: new Map(),        // convs I'm a member of (DMs, groups, joined channels)
  channels: new Map(),       // every channel
  readState: {},             // my read positions: cid -> Timestamp
  unread: {},                // cid -> count
  tab: 'chats',
  filter: 'all',
  search: '',
  open: null,                // conversation id
  msgs: [],                  // open conversation's messages
  msgLimit: 60,
  convReads: {},             // uid -> Timestamp, for ticks
  typing: {},                // uid -> Timestamp
  thread: null,              // message id
  threadRoot: null,
  replies: [],
  replyTo: null,             // { id, from, text }
  editing: null,             // { path, text }
  actionFor: null,           // message key with the action bar open
  settingsView: null,        // 'devices' on the right pane
  devices: [],
  deviceSeen: false,
  joining: false,
};
const subs = {};             // name -> unsubscribe
const unsub = (name) => { if (subs[name]) { subs[name](); delete subs[name]; } };
const unsubAll = () => Object.keys(subs).forEach(unsub);

const user = (uid) => S.users.get(uid) || { displayName: uid === S.uid ? 'You' : 'Someone', username: '', color: colorFor(uid) };
const nameOf = (uid) => (uid === S.uid ? 'You' : user(uid).displayName);
const firstName = (uid) => (uid === S.uid ? 'You' : String(user(uid).displayName).split(' ')[0]);
const conv = (cid) => S.myConvs.get(cid) || S.channels.get(cid) || null;
const isMemberOf = (c) => c && Array.isArray(c.members) && c.members.includes(S.uid);
const dmPeer = (c) => c.members.find((u) => u !== S.uid) || S.uid;
const convTitle = (c) => (c.type === 'dm' ? (dmPeer(c) === S.uid ? 'Notes (you)' : nameOf(dmPeer(c))) : c.type === 'channel' ? c.name : c.name);
const pathOf = (m) => (m.parent ? `convs/${S.open}/msgs/${m.parent}/replies/${m.id}` : `convs/${S.open}/msgs/${m.id}`);

// ---------- Toast, sheets ----------
let toastTimer;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

function sheet(build) {
  const wrap = document.createElement('div');
  wrap.className = 'sheet-wrap';
  const box = document.createElement('div');
  box.className = 'sheet';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  wrap.append(box);
  const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  document.addEventListener('keydown', onKey);
  box.innerHTML = '<span class="grab"></span>';
  build(box, close);
  $('#overlay').append(wrap);
  const first = box.querySelector('input, textarea');
  if (first && wide.matches) first.focus();
  return close;
}

function confirmSheet(title, text, okLabel, danger = false) {
  return new Promise((resolve) => {
    sheet((box, close) => {
      box.insertAdjacentHTML('beforeend', `<h2>${esc(title)}</h2>${text ? `<p>${esc(text)}</p>` : ''}
        <div class="actions"><button class="btn ghost" data-a="no">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-a="yes">${esc(okLabel)}</button></div>`);
      box.addEventListener('click', (e) => {
        const a = e.target.closest('[data-a]')?.dataset.a;
        if (!a) return;
        close();
        resolve(a === 'yes');
      });
    });
  });
}

function avatarHtml(uid, cls = '') {
  const u = user(uid);
  const dot = isOnline(u.lastSeen) && uid !== S.uid && !cls.includes('xs') ? '<i class="dot"></i>' : '';
  return `<span class="avatar ${cls}" style="background:${esc(u.color || colorFor(uid))}">${esc(initials(u.displayName))}${dot}</span>`;
}
function convAvatar(c, cls = '') {
  if (c.type === 'dm') return avatarHtml(dmPeer(c), cls);
  if (c.type === 'channel') return `<span class="avatar chan ${cls}">#</span>`;
  return `<span class="avatar group ${cls}" style="background:${colorFor(c.name || c.id)}">${ic('people')}</span>`;
}

// ---------- Text formatting ----------
function formatText(text) {
  let html = esc(text);
  html = html.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
  html = html.replace(/\*([^*\n]{1,200})\*/g, '<b>$1</b>');
  const me = user(S.uid).displayName;
  html = html.replace(/@(all|channel|[\p{L}\p{N}._-]+(?: [\p{L}\p{N}._-]+){0,2})/gu, (all, name) => {
    const hit = name === 'all' || name === 'channel' || [...S.users.values()].some((u) => u.displayName === name);
    if (!hit) return all;
    return `<span class="mention ${name === me || name === 'all' ? 'me' : ''}">@${name}</span>`;
  });
  return html;
}
function detectMentions(text, c) {
  const out = new Set();
  if (/@(all|channel)\b/.test(text) && c.type !== 'dm') out.add('all');
  for (const [uid, u] of S.users) if (u.displayName && text.includes(`@${u.displayName}`)) out.add(uid);
  out.delete(S.uid);
  return [...out];
}

// ---------- Boot ----------
function takeLinkFromUrl() {
  if (location.pathname === '/link' && location.hash.length > 1) {
    try { sessionStorage.setItem('mm.pendingLink', location.href); } catch { /* storage unavailable */ }
  }
  if (location.pathname === '/link') history.replaceState(null, '', '/');
}

let stopLink = null;
onAuthStateChanged(auth, async (u) => {
  if (S.joining) return;
  if (u && !u.isAnonymous) {
    const prof = await getDoc(doc(db, `users/${u.uid}`)).catch(() => null);
    if (!prof || !prof.exists()) {
      await D.signOutHere();
      showAuth('signin', 'This account is not set up yet. Join with your team code.');
      return;
    }
    if (stopLink) { stopLink(); stopLink = null; }
    startApp(u.uid, prof.data());
  } else if (u && u.isAnonymous) {
    // A computer waiting for a phone to approve its QR code.
    if (!stopLink && $('#app').hidden) showAuth(defaultAuthMode());
  } else {
    stopApp();
    showAuth(defaultAuthMode());
  }
});

function defaultAuthMode() {
  let pending = false;
  try { pending = Boolean(sessionStorage.getItem('mm.pendingLink')); } catch { /* storage unavailable */ }
  return wide.matches && !native && !pending ? 'qr' : 'signin';
}

// ---------- Sign-in screens ----------
function showAuth(mode, message = '') {
  $('#boot').hidden = true;
  $('#app').hidden = true;
  const box = $('#auth');
  box.hidden = false;
  if (mode !== 'qr' && stopLink) { stopLink(); stopLink = null; }
  document.title = APP_NAME;

  if (mode === 'qr') {
    box.innerHTML = `<section class="qr-card">
      <div><h1>Use ${APP_NAME} on this computer</h1>
        <ol>
          <li>Open <b>${APP_NAME}</b> on your phone</li>
          <li>Tap <span class="inline-ic">${ic('qr')}</span> on the Chats screen, or <b>Settings → Linked devices</b></li>
          <li>Tap <b>Link a device</b> and point your phone at this screen</li>
        </ol></div>
      <div class="qr-side"><div class="qr-box" id="qrBox"><span class="muted">Getting a code…</span></div><small id="qrNote">The code changes every minute</small></div>
      <div class="qr-foot"><span id="qrStatus">No password needed. Your chats stay in sync on phone and computer.</span>
        <button class="link-btn" id="toPin">Sign in with username and PIN instead</button></div>
    </section>`;
    $('#toPin').onclick = () => showAuth('signin');
    let rounds = 0;
    if (stopLink) stopLink();
    stopLink = D.startLinkAsComputer((up) => {
      const qrBox = $('#qrBox');
      if (!qrBox) return;
      if (up.qr) {
        if (++rounds > 5) {
          stopLink && stopLink();
          stopLink = null;
          qrBox.classList.add('faded');
          qrBox.insertAdjacentHTML('beforeend', '<button class="qr-reload" id="qrReload">↻ Get a new code</button>');
          $('#qrReload').onclick = () => showAuth('qr');
          return;
        }
        drawQr(qrBox, up.qr);
      } else if (up.status === 'approved') {
        $('#qrStatus').outerHTML = `<span class="ok">${ic('ticks')} Linked. Opening your chats…</span>`;
      } else if (up.status === 'error') {
        $('#qrStatus').textContent = up.message;
      }
    });
    return;
  }

  const joining = mode === 'join';
  box.innerHTML = `<section class="auth-card">
    <div class="head"><span class="logo">MC</span><div><h1>${APP_NAME}</h1><small>Madani Channel staff messenger</small></div></div>
    <div class="seg" role="group" aria-label="Sign in or join">
      <button type="button" data-mode="signin" aria-pressed="${!joining}">Sign in</button>
      <button type="button" data-mode="join" aria-pressed="${joining}">Join</button>
    </div>
    <form id="authForm" autocomplete="on" novalidate>
      ${joining ? `<label class="field">Team code<input name="teamCode" required autocomplete="off" placeholder="Ask your department head"></label>` : ''}
      <label class="field">Username<input name="username" required autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="e.g. ali.raza"></label>
      ${joining ? `<label class="field">Full name<input name="displayName" required maxlength="60" autocomplete="name" placeholder="e.g. Muhammad Ali Raza"></label>
        <label class="field">Department or role<input name="title" maxlength="60" placeholder="e.g. Promo department"></label>` : ''}
      <label class="field">PIN<input name="pin" type="password" inputmode="numeric" required minlength="6" autocomplete="${joining ? 'new-password' : 'current-password'}" placeholder="${joining ? 'Choose 6 or more digits' : '6 or more digits'}"></label>
      <p class="error" id="authError" role="alert">${esc(message)}</p>
      <button class="btn primary" type="submit">${joining ? 'Create my account' : 'Sign in'}</button>
    </form>
    <div class="auth-foot">${wide.matches && !native ? '<button class="link-btn" id="toQr">Link with your phone (QR code) instead</button>' : ''}
      ${usingEmulators ? '<p class="muted" style="font-size:12px;margin:6px 0 0">Test mode: local Firebase emulator</p>' : ''}</div>
  </section>`;
  box.querySelectorAll('[data-mode]').forEach((b) => { b.onclick = () => showAuth(b.dataset.mode); });
  if ($('#toQr')) $('#toQr').onclick = () => showAuth('qr');
  $('#authForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const btn = e.target.querySelector('button[type=submit]');
    $('#authError').textContent = '';
    btn.disabled = true;
    try {
      if (joining) {
        if (!f.teamCode || !f.username || !f.displayName || !f.pin) throw new Error('Please fill in the team code, username, full name and PIN.');
        S.joining = true;
        await D.join(f);
        S.joining = false;
        const prof = await getDoc(doc(db, `users/${auth.currentUser.uid}`));
        startApp(auth.currentUser.uid, prof.data());
      } else {
        if (!f.username || !f.pin) throw new Error('Type your username and PIN.');
        await D.signInWithPin(f.username, f.pin);
      }
    } catch (err) {
      S.joining = false;
      $('#authError').textContent = err.message;
      btn.disabled = false;
    }
  };
  const first = box.querySelector('input');
  if (first && wide.matches) first.focus();
}

function drawQr(box, text) {
  const qr = window.qrcode(0, 'Q');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const q = 2;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + q} ${r + q}h1v1h-1z`;
  box.classList.remove('faded');
  box.innerHTML = `<svg viewBox="0 0 ${n + q * 2} ${n + q * 2}" shape-rendering="crispEdges" role="img" aria-label="QR code to link this computer">
    <rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#0F1F18"/></svg><span class="logo qr-logo">MC</span>`;
}

// ---------- App start / stop ----------
let heartbeatTimer;
function startApp(uid, profile) {
  if (S.uid === uid && !$('#app').hidden) return;
  stopApp();
  S.uid = uid;
  S.users.set(uid, { uid, ...profile });
  $('#boot').hidden = true;
  $('#auth').hidden = true;
  $('#auth').innerHTML = '';
  $('#app').hidden = false;
  document.title = APP_NAME;

  let firstConvs = true;
  subs.users = D.watchUsers((list) => {
    S.users = new Map(list.map((u) => [u.uid, u]));
    renderList(); renderNav();
    if (S.open) { renderConvHead(); renderMsgs(); }
  });
  subs.convs = D.watchMyConvs(uid, (snap) => {
    snap.docChanges().forEach((ch) => {
      const c = { id: ch.doc.id, ...ch.doc.data() };
      if (ch.type === 'removed') { S.myConvs.delete(c.id); return; }
      const prev = S.myConvs.get(c.id);
      S.myConvs.set(c.id, c);
      if (!firstConvs && c.last && c.last.from !== S.uid && c.last.id && (!prev || prev.last?.id !== c.last.id)) incoming(c);
    });
    firstConvs = false;
    refreshUnread();
    renderList(); renderNav();
    if (S.open && conv(S.open)) renderConvHead();
  });
  subs.channels = D.watchChannels((snap) => {
    S.channels = new Map(snap.docs.map((d) => [d.id, { id: d.id, ...d.data() }]));
    if (S.tab === 'channels') renderList();
    if (S.open && S.channels.has(S.open)) { renderConvHead(); renderComposerArea(); }
  });
  subs.reads = D.watchReadState(uid, (r) => { S.readState = r; refreshUnread(); renderList(); renderNav(); });

  // This device: register it, and sign out if it is removed from another device.
  const did = D.deviceId();
  let via = { via: 'pin' };
  try { via = JSON.parse(sessionStorage.getItem('mm.via') || 'null') || via; sessionStorage.removeItem('mm.via'); } catch { /* storage unavailable */ }
  S.deviceSeen = false;
  D.registerDevice(uid, did, via).catch(() => {});
  subs.device = D.watchDevice(uid, did, (snap) => {
    if (snap.exists()) S.deviceSeen = true;
    else if (S.deviceSeen && !snap.metadata.hasPendingWrites) {
      toast('This device was signed out from your phone.');
      D.signOutHere();
    }
  });
  subs.devices = D.watchDevices(uid, (list) => { S.devices = list; if (S.settingsView === 'devices' || S.tab === 'settings') { renderList(); renderSettingsPane(); } });

  D.heartbeat(uid);
  heartbeatTimer = setInterval(() => { if (document.visibilityState === 'visible') D.heartbeat(uid); }, 60_000);

  S.tab = 'chats';
  renderNav();
  renderList();
  renderConvEmpty();
  setPane('list');
  setTimeout(runPendingLink, 600);
}

function stopApp() {
  unsubAll();
  clearInterval(heartbeatTimer);
  closeConv(false);
  Object.assign(S, { uid: null, myConvs: new Map(), channels: new Map(), users: new Map(), readState: {}, unread: {}, open: null, devices: [] });
  $('#app').hidden = true;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.uid) {
    D.heartbeat(S.uid);
    if (S.open) D.markRead(S.open, S.uid);
  }
});
wide.addEventListener('change', () => { if (S.uid) { renderList(); setPane(S.open ? 'conv' : 'list'); } });

function setPane(p) {
  const app = $('#app');
  app.dataset.pane = p;
  app.classList.toggle('with-thread', Boolean(S.thread) && wide.matches);
  $('#threadPane').hidden = !S.thread;
}

// ---------- Unread + notifications ----------
const unreadTimers = {};
function isUnread(c) {
  if (!c.last || c.last.from === S.uid || c.last.kind === 'system') return false;
  if (c.id === S.open && document.visibilityState === 'visible') return false;
  return ms(c.last.ts) > ms(S.readState[c.id] || 0) + 1;
}
function refreshUnread() {
  for (const c of S.myConvs.values()) {
    if (!isUnread(c)) { delete S.unread[c.id]; continue; }
    clearTimeout(unreadTimers[c.id]);
    unreadTimers[c.id] = setTimeout(async () => {
      try {
        S.unread[c.id] = Math.max(1, await D.unreadCount(c.id, S.readState[c.id] || null));
      } catch { S.unread[c.id] = 1; }
      renderList(); renderNav();
    }, 400);
    if (!S.unread[c.id]) S.unread[c.id] = 1;
  }
}

let audioCtx;
function beep() {
  try {
    audioCtx = audioCtx || new AudioContext();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.12, audioCtx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.25);
    o.connect(g).connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + 0.26);
  } catch { /* sound unavailable */ }
}
function incoming(c) {
  const here = c.id === S.open && document.visibilityState === 'visible';
  if (here) return;
  beep();
  if (document.visibilityState === 'hidden' && 'Notification' in window && Notification.permission === 'granted' && !native) {
    const who = nameOf(c.last.from);
    const title = c.type === 'dm' ? who : c.type === 'channel' ? `#${c.name}` : c.name;
    const n = new Notification(title, { body: c.type === 'dm' ? c.last.text : `${who}: ${c.last.text}`, tag: c.id, icon: '/icon.svg' });
    n.onclick = () => { window.focus(); openConv(c.id); n.close(); };
  }
}

// ---------- Navigation ----------
const TABS = [['chats', 'Chats', 'chats'], ['channels', 'Channels', 'hash'], ['calls', 'Calls', 'phone'], ['settings', 'Settings', 'gear']];
function renderNav() {
  const counts = { chats: 0, channels: 0 };
  for (const c of S.myConvs.values()) if (S.unread[c.id]) counts[c.type === 'channel' ? 'channels' : 'chats']++;
  $('#nav').innerHTML = `<span class="logo">MC</span>${TABS.map(([k, label, icon]) => `<button class="tab" data-tab="${k}" ${S.tab === k ? 'aria-current="page"' : ''}>
      <span class="pill">${ic(icon)}</span>${label}${counts[k] ? `<span class="count">${counts[k]}</span>` : ''}</button>`).join('')}
    <span class="spacer"></span><button class="me-btn" data-tab="settings" title="${esc(user(S.uid).displayName)}">${avatarHtml(S.uid, 'sm')}</button>`;
  const unreadTotal = counts.chats + counts.channels;
  document.title = unreadTotal ? `(${unreadTotal}) ${APP_NAME}` : APP_NAME;
}
$('#nav').addEventListener('click', (e) => {
  const t = e.target.closest('[data-tab]');
  if (!t) return;
  S.tab = t.dataset.tab;
  S.search = '';
  if (S.tab === 'settings') S.settingsView = null;
  renderNav();
  renderList();
  if (wide.matches) {
    if (S.tab === 'settings') { closeConv(false); renderSettingsPane(); }
    else if (S.tab === 'calls') { closeConv(false); renderConvEmpty(); }
    else if (!S.open) renderConvEmpty();
  } else setPane('list');
});

// ---------- Lists ----------
function sortedChats() {
  return [...S.myConvs.values()].filter((c) => c.type !== 'channel')
    .sort((a, b) => ms(b.updatedAt) - ms(a.updatedAt));
}
function rowPreview(c) {
  const t = S.typing && c.id === S.open && Object.keys(S.typing).some((u) => u !== S.uid && Date.now() - ms(S.typing[u]) < 6000);
  if (t) return '<span style="color:var(--brand);font-weight:600">typing…</span>';
  if (!c.last) return c.type === 'channel' ? esc(c.topic || 'No messages yet') : 'Say Assalam-o-Alaikum 👋';
  const mine = c.last.from === S.uid;
  const peerRead = false;
  const ticks = mine ? `<span class="${peerRead ? 'read' : ''}">${ic('tick')}</span> ` : '';
  const who = c.type !== 'dm' && !mine && c.last.kind !== 'system' ? `${esc(firstName(c.last.from))}: ` : mine && c.type !== 'dm' ? 'You: ' : '';
  return `${ticks}${who}<span ${isRtl(c.last.text) ? 'dir="rtl"' : ''}>${esc(c.last.text)}</span>`;
}
function convRow(c) {
  const n = S.unread[c.id] || 0;
  return `<button class="row ${S.open === c.id ? 'active' : ''} ${n ? 'unread' : ''}" data-open="${c.id}">
    ${convAvatar(c)}
    <span class="row-main">
      <span class="row-top"><b>${c.type === 'channel' ? '# ' : ''}${esc(convTitle(c))}</b><time class="${n ? 'hot' : ''}">${c.last ? esc(listTime(c.last.ts || c.updatedAt)) : ''}</time></span>
      <span class="row-bottom"><span class="preview">${rowPreview(c)}</span>${n ? `<span class="badge">${n > 99 ? '99+' : n}</span>` : ''}</span>
    </span></button>`;
}

function renderList() {
  if (!S.uid) return;
  const pane = $('#listPane');
  const keepSearch = document.activeElement && document.activeElement.id === 'listSearch';
  const head = {
    chats: `<div class="appbar"><h1>${wide.matches ? 'Chats' : APP_NAME}</h1>
      <button class="icon-btn hide-wide" data-act="link-device" title="Link a computer" aria-label="Link a computer">${ic('qr')}</button>
      <button class="icon-btn" data-act="new-chat" title="New chat" aria-label="New chat">${ic('edit')}</button>
      <button class="icon-btn" data-act="new-group" title="New group" aria-label="New group">${ic('people')}</button></div>`,
    channels: `<div class="appbar"><h1>Channels</h1><button class="icon-btn" data-act="new-channel" title="Create a channel" aria-label="Create a channel">${ic('plus')}</button></div>`,
    calls: '<div class="appbar"><h1>Calls</h1></div>',
    settings: '<div class="appbar"><h1>Settings</h1></div>',
  }[S.tab];

  let body = '';
  const q = S.search.toLowerCase();
  if (S.tab === 'chats') {
    let list = sortedChats();
    if (S.filter === 'unread') list = list.filter((c) => S.unread[c.id]);
    if (S.filter === 'groups') list = list.filter((c) => c.type === 'group');
    if (q) list = list.filter((c) => convTitle(c).toLowerCase().includes(q));
    const people = q ? [...S.users.values()].filter((u) => u.uid !== S.uid && !S.myConvs.has(D.dmId(S.uid, u.uid))
      && (`${u.displayName} ${u.username}`).toLowerCase().includes(q)) : [];
    body = `<div class="search">${ic('search')}<input id="listSearch" value="${esc(S.search)}" placeholder="Search chats and people" aria-label="Search chats and people"></div>
      <div class="chips" role="group" aria-label="Filter">${['all', 'unread', 'groups'].map((k) => `<button class="chip" data-filter="${k}" aria-pressed="${S.filter === k}">${k[0].toUpperCase() + k.slice(1)}</button>`).join('')}</div>
      <div class="list">${list.map(convRow).join('')}
        ${people.length ? `<div class="section-label">People</div>${people.map((u) => `<button class="row" data-dm="${u.uid}">${avatarHtml(u.uid)}<span class="row-main"><b>${esc(u.displayName)}</b><span class="preview">${esc(u.title || '@' + u.username)}</span></span></button>`).join('')}` : ''}
        ${!list.length && !people.length ? `<div class="list-empty">${S.myConvs.size ? '<span>Nothing matches.</span>' : `<b>Start a conversation</b><span>Message a colleague or create a group for your team.</span><button class="btn primary small" data-act="new-chat">${ic('edit')} New chat</button>`}</div>` : ''}
      </div><button class="fab" data-act="new-chat" aria-label="New chat">${ic('edit')}</button>`;
  } else if (S.tab === 'channels') {
    const all = [...S.channels.values()].filter((c) => !q || c.name.includes(q) || (c.topic || '').toLowerCase().includes(q));
    const mine = all.filter(isMemberOf).sort((a, b) => ms(b.updatedAt) - ms(a.updatedAt));
    const others = all.filter((c) => !isMemberOf(c));
    body = `<div class="search">${ic('search')}<input id="listSearch" value="${esc(S.search)}" placeholder="Search channels" aria-label="Search channels"></div>
      <div class="list">
        ${mine.length ? `<div class="section-label">Your channels</div>${mine.map((c) => convRow(S.myConvs.get(c.id) || c)).join('')}` : ''}
        ${others.length ? `<div class="section-label">More channels</div>${others.map((c) => `<button class="row ${S.open === c.id ? 'active' : ''}" data-open="${c.id}"><span class="avatar chan">#</span><span class="row-main"><span class="row-top"><b># ${esc(c.name)}</b></span><span class="row-bottom"><span class="preview">${esc(c.topic || `${(c.members || []).length} members`)}</span></span></span></button>`).join('')}` : ''}
        ${!all.length ? `<div class="list-empty"><b>No channels yet</b><span>Create one for your department, e.g. #promo or #news-desk.</span><button class="btn primary small" data-act="new-channel">${ic('plus')} Create a channel</button></div>` : ''}
      </div>`;
  } else if (S.tab === 'calls') {
    body = `<div class="list"><div class="list-empty" style="padding-top:60px">${ic('phone', 'width="44" height="44" style="color:var(--brand)"')}<b>Voice and video calls</b><span>Calls are coming in the next update. For now, use voice notes: hold the mic in any chat.</span></div></div>`;
  } else {
    body = settingsList();
  }
  pane.innerHTML = head + body;
  if (keepSearch) { const s = $('#listSearch'); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
}

$('#listPane').addEventListener('input', (e) => {
  if (e.target.id === 'listSearch') { S.search = e.target.value; renderList(); }
});
$('#listPane').addEventListener('click', async (e) => {
  const el = e.target.closest('[data-open],[data-dm],[data-filter],[data-act],[data-set]');
  if (!el) return;
  if (el.dataset.open) return openConv(el.dataset.open);
  if (el.dataset.dm) return openDm(el.dataset.dm);
  if (el.dataset.filter) { S.filter = el.dataset.filter; return renderList(); }
  if (el.dataset.set) return settingsAction(el.dataset.set, el);
  const act = el.dataset.act;
  if (act === 'new-chat') newChatSheet();
  if (act === 'new-group') newGroupSheet();
  if (act === 'new-channel') newChannelSheet();
  if (act === 'link-device') { S.tab = 'settings'; renderNav(); renderList(); openDevices(); }
});

async function openDm(other) {
  try {
    const id = await D.ensureDm(S.uid, other);
    S.tab = 'chats';
    renderNav();
    openConv(id);
  } catch (err) { toast(err.message); }
}

// ---------- Conversation ----------
function renderConvEmpty() {
  $('#convPane').innerHTML = `<div class="messages"><div class="conv-empty">${ic('chats', 'width="54" height="54" style="color:var(--brand);opacity:.75"')}
    <b>${APP_NAME}</b><span>Pick a chat or channel. Messages arrive here and on your phone at the same time.</span></div></div>`;
}

function closeConv(render = true) {
  ['msgs', 'convReads', 'typing', 'thread', 'threadRoot'].forEach(unsub);
  stopVoice();
  S.open = null; S.msgs = []; S.thread = null; S.replies = []; S.replyTo = null; S.editing = null; S.actionFor = null; S.typing = {};
  if (render) { renderList(); setPane('list'); }
}

function openConv(cid) {
  const c = conv(cid);
  if (!c) return;
  if (S.open !== cid) {
    closeConv(false);
    S.open = cid;
    S.msgLimit = 60;
    S.settingsView = null;
    subs.msgs = D.watchMsgs(cid, S.msgLimit, onMsgs);
    if (c.type !== 'channel') subs.convReads = D.watchConvReads(cid, (r) => { S.convReads = r; renderMsgs(); });
    subs.typing = D.watchTyping(cid, (t) => { S.typing = t; renderConvHead(); renderTypingBubble(); });
  }
  if (c.type === 'channel' && S.tab !== 'channels') { S.tab = 'channels'; renderNav(); }
  if (c.type !== 'channel' && S.tab !== 'chats') { S.tab = 'chats'; renderNav(); }
  renderConvShell();
  renderList();
  setPane('conv');
  D.markRead(cid, S.uid);
  delete S.unread[cid];
  renderNav();
}

let firstSnap = true;
function onMsgs(snap) {
  const box = $('#msgs');
  const nearBottom = !box || box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  S.msgs = snap.docs.map((d) => ({ id: d.id, pending: d.metadata.hasPendingWrites, ...d.data() }));
  renderMsgs(nearBottom || firstSnap);
  firstSnap = false;
  if (document.visibilityState === 'visible') D.markRead(S.open, S.uid);
  if (S.thread) {
    const root = S.msgs.find((m) => m.id === S.thread);
    if (root) { S.threadRoot = root; renderThreadRoot(); }
  }
}

function renderConvShell() {
  const c = conv(S.open);
  firstSnap = true;
  $('#convPane').innerHTML = `<header class="convbar" id="convHead"></header><div id="pinnedBar"></div>
    <div class="messages ${c.type === 'channel' ? 'channel' : ''}" id="msgs" aria-live="polite"></div>
    <div id="composerArea"></div>`;
  renderConvHead();
  renderComposerArea();
  renderMsgs(true);
}

function typingNames() {
  return Object.entries(S.typing).filter(([u, t]) => u !== S.uid && Date.now() - ms(t) < 6000).map(([u]) => u);
}

function renderConvHead() {
  const c = conv(S.open);
  const head = $('#convHead');
  if (!c || !head) return;
  const typers = typingNames();
  let sub;
  if (typers.length) sub = `<small class="typing">${c.type === 'dm' ? 'typing…' : `${esc(typers.map(firstName).join(', '))} ${typers.length > 1 ? 'are' : 'is'} typing…`}</small>`;
  else if (c.type === 'dm') { const p = user(dmPeer(c)); sub = `<small>${dmPeer(c) === S.uid ? 'Only you can see this' : `${esc(lastSeenText(p.lastSeen))}${p.title ? ` · ${esc(p.title)}` : ''}`}</small>`; }
  else if (c.type === 'group') sub = `<small>${esc(c.members.map(firstName).join(', '))}</small>`;
  else sub = `<small>${esc(c.topic || `${(c.members || []).length} members`)}</small>`;
  head.innerHTML = `<button class="icon-btn back-btn" data-act="back" aria-label="Back">${ic('back')}</button>
    ${convAvatar(c, 'sm')}<button class="who" data-act="info"><b>${c.type === 'channel' ? '# ' : ''}${esc(convTitle(c))}</b>${sub}</button>
    ${c.type !== 'channel' && dmPeer(c) !== S.uid ? `<button class="icon-btn" data-act="call" aria-label="Video call" title="Video call">${ic('video')}</button><button class="icon-btn" data-act="call" aria-label="Voice call" title="Voice call">${ic('phone')}</button>` : ''}
    <button class="icon-btn" data-act="info" aria-label="Details" title="Details">${ic('more')}</button>`;
  setTimeout(() => { if (S.open === c.id && typingNames().length) renderConvHead(); }, 6100);
  $('#pinnedBar').innerHTML = c.pinned ? `<div class="pinned">${ic('pin')}<span><b>Pinned:</b> ${esc(c.pinned)}</span></div>` : '';
}

function renderTypingBubble() {
  const box = $('#msgs');
  if (!box) return;
  const c = conv(S.open);
  box.querySelector('.typing-bubble')?.remove();
  if (c && c.type !== 'channel' && typingNames().length) {
    const near = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    box.insertAdjacentHTML('beforeend', '<div class="typing-bubble" aria-label="typing"><i></i><i></i><i></i></div>');
    if (near) box.scrollTop = box.scrollHeight;
    setTimeout(renderTypingBubble, 6100);
  }
}

function tickFor(m, c) {
  if (m.from !== S.uid || m.deleted) return '';
  if (m.pending) return `<span title="Sending">${ic('clock')}</span>`;
  const others = c.members.filter((u) => u !== S.uid);
  const seen = others.length && others.every((u) => S.convReads[u] && ms(S.convReads[u]) >= ms(m.ts));
  return `<span class="${seen ? 'read' : ''}" title="${seen ? 'Seen' : 'Sent'}">${ic(seen ? 'ticks' : 'tick')}</span>`;
}

function reactionsHtml(m) {
  const r = m.reactions || {};
  const groups = {};
  for (const [u, e] of Object.entries(r)) (groups[e] = groups[e] || []).push(u);
  const keys = Object.keys(groups);
  if (!keys.length) return '';
  return `<div class="reacts">${keys.map((e) => `<button data-react="${esc(e)}" data-key="${m.key}" class="${groups[e].includes(S.uid) ? 'mine' : ''}" title="${esc(groups[e].map(nameOf).join(', '))}">${e} ${groups[e].length}</button>`).join('')}</div>`;
}

function attachmentHtml(m) {
  if (m.deleted || !m.file) return '';
  const f = m.file;
  if (m.kind === 'voice') {
    const bars = Array.from({ length: 28 }, (_, i) => 6 + Math.round(Math.abs(Math.sin((i + 1) * 1.7 + f.size % 7)) * 20));
    return `<div class="voice" data-voice="${esc(f.path)}" data-key="${m.key}"><button class="play" data-play="${m.key}" aria-label="Play voice message">${ic('play')}</button>
      <span class="track" data-seek="${m.key}">${bars.map((h) => `<i style="height:${h}px"></i>`).join('')}</span><small>${fmtDur(f.dur || 0)}</small></div>`;
  }
  if (m.kind === 'image') return `<button class="media loading" data-img="${esc(f.path)}" aria-label="Open photo">${ic('image', 'width="28" height="28"')}</button>`;
  if (/^video\//.test(f.type)) return `<div class="media loading" data-video="${esc(f.path)}">${ic('video', 'width="28" height="28"')}</div>`;
  const ext = (f.name.split('.').pop() || 'file').slice(0, 4).toUpperCase();
  return `<a class="filecard" data-file="${esc(f.path)}" href="#" target="_blank" rel="noopener"><span class="ext ${ext === 'PDF' ? 'pdf' : ''}">${esc(ext)}</span><div><b>${esc(f.name)}</b><small>${esc(fmtSize(f.size))}</small></div>${ic('download')}</a>`;
}

function textHtml(m) {
  if (m.deleted) return `<span class="text">${ic('trash', 'width="14" height="14" style="vertical-align:-2px"')} This message was deleted</span>`;
  if (!m.text) return '';
  return `<span class="text" ${isRtl(m.text) ? 'dir="rtl"' : ''}>${formatText(m.text)}</span>${m.edited ? ' <span class="edited">(edited)</span>' : ''}`;
}

function actionsBar(m, c, inThread) {
  if (S.actionFor !== m.key || m.deleted) return '';
  const mine = m.from === S.uid;
  return `<div class="actions-bar" role="toolbar" aria-label="Message actions">
    ${EMOJI.map((e) => `<button data-react="${e}" data-key="${m.key}" aria-label="React ${e}">${e}</button>`).join('')}<span class="sep"></span>
    ${c.type === 'channel' && !inThread ? `<button data-thread="${m.id}" title="Reply in thread" aria-label="Reply in thread">${ic('thread')}</button>` : ''}
    ${c.type !== 'channel' ? `<button data-reply="${m.key}" title="Reply" aria-label="Reply">${ic('reply')}</button>` : ''}
    ${mine && m.text && !m.parent ? `<button data-edit="${m.key}" title="Edit" aria-label="Edit">${ic('edit')}</button>` : ''}
    ${mine ? `<button data-del="${m.key}" title="Delete for everyone" aria-label="Delete for everyone">${ic('trash')}</button>` : ''}
  </div>`;
}

const msgIndex = new Map(); // key -> message (for actions)
function bubbleHtml(m, i, list, c) {
  const out = m.from === S.uid;
  const prev = list[i - 1];
  const first = !prev || prev.from !== m.from || !sameDayTs(prev.ts, m.ts) || ms(m.ts) - ms(prev.ts) > 5 * 60e3;
  const sender = c.type === 'group' && !out && first ? `<span class="sender" style="color:${esc(user(m.from).color || colorFor(m.from))}">${esc(nameOf(m.from))}</span>` : '';
  const quote = m.reply ? `<button class="quote" data-jump="${esc(m.reply.id)}"><b>${esc(m.reply.from === S.uid ? 'You' : nameOf(m.reply.from))}</b><span>${esc(m.reply.text)}</span></button>` : '';
  return `<div class="msg ${out ? 'out' : ''} ${first ? 'first' : ''} ${m.deleted ? 'deleted' : ''}" data-msg="${m.key}" id="m-${m.id}">
    ${actionsBar(m, c)}${sender}${quote}${attachmentHtml(m)}${textHtml(m)}
    <span class="meta">${esc(fmtTime(m.ts))}${tickFor(m, c)}</span>${reactionsHtml(m)}</div>`;
}

function cmsgHtml(m, i, list, c, inThread = false) {
  const prev = list[i - 1];
  const cont = prev && prev.from === m.from && sameDayTs(prev.ts, m.ts) && ms(m.ts) - ms(prev.ts) < 5 * 60e3 && !prev.threadCount && !inThread;
  const u = user(m.from);
  const thread = !inThread && m.threadCount ? `<button class="thread-link" data-thread="${m.id}">
      <span class="faces">${(m.threadUsers || []).slice(0, 3).map((x) => avatarHtml(x, 'xs')).join('')}</span>
      <span>${m.threadCount} ${m.threadCount === 1 ? 'reply' : 'replies'}</span><small>Last reply ${esc(listTime(m.threadLast))}</small></button>` : '';
  return `<div class="cmsg ${cont ? 'cont' : ''} ${m.deleted ? 'deleted' : ''}" data-msg="${m.key}" id="m-${m.id}">${actionsBar(m, c, inThread)}${avatarHtml(m.from, 'sm')}
    <div class="body">${cont ? '' : `<div class="head"><b>${esc(u.displayName)}</b>${u.title ? `<span class="title">${esc(u.title)}</span>` : ''}<time>${esc(fmtTime(m.ts))}</time></div>`}
      ${attachmentHtml(m)}${m.text || m.deleted ? `<p class="text">${textHtml(m)}</p>` : ''}${reactionsHtml(m)}${thread}</div></div>`;
}

const sameDayTs = (a, b) => new Date(ms(a)).toDateString() === new Date(ms(b)).toDateString();

function messagesHtml(list, c, inThread) {
  let html = '';
  let lastDay = '';
  list.forEach((m, i) => {
    m.key = inThread ? `r:${m.id}` : `m:${m.id}`;
    msgIndex.set(m.key, m);
    const day = dayLabel(m.ts);
    if (day !== lastDay && !inThread) { html += `<div class="daysep">${esc(day)}</div>`; lastDay = day; }
    html += c.type === 'channel' || inThread ? cmsgHtml(m, i, list, c, inThread) : bubbleHtml(m, i, list, c);
  });
  return html;
}

function renderMsgs(stick = false) {
  const box = $('#msgs');
  const c = conv(S.open);
  if (!box || !c) return;
  const top = box.scrollTop;
  const nearBottom = box.scrollHeight - top - box.clientHeight < 120;
  const more = S.msgs.length >= S.msgLimit ? '<button class="btn ghost small load-more" data-act="more">Load earlier messages</button>' : '';
  const empty = !S.msgs.length ? `<div class="conv-empty">${convAvatar(c, 'lg')}<b>${esc(convTitle(c))}</b><span>${c.type === 'channel' ? esc(c.topic || 'This is the start of the channel.') : c.type === 'dm' ? 'Messages are stored on Madani Channel\'s secure server. Say Assalam-o-Alaikum 👋' : 'This is the start of the group.'}</span></div>` : '';
  box.innerHTML = more + empty + messagesHtml(S.msgs, c, false);
  hydrate(box);
  renderTypingBubble();
  if (stick || nearBottom) box.scrollTop = box.scrollHeight; else box.scrollTop = top;
}

// Fill in photos, videos and file links once their download URLs are known.
function hydrate(root) {
  root.querySelectorAll('[data-img]').forEach(async (el) => {
    try {
      const url = await D.fileUrl(el.dataset.img);
      el.classList.remove('loading');
      el.innerHTML = `<img src="${esc(url)}" alt="Photo" loading="lazy">`;
      el.onclick = () => lightbox(url);
    } catch { el.textContent = 'Photo unavailable'; }
  });
  root.querySelectorAll('[data-video]').forEach(async (el) => {
    try {
      const url = await D.fileUrl(el.dataset.video);
      el.classList.remove('loading');
      el.innerHTML = `<video src="${esc(url)}" controls preload="metadata" playsinline></video>`;
    } catch { el.textContent = 'Video unavailable'; }
  });
  root.querySelectorAll('[data-file]').forEach(async (el) => {
    el.addEventListener('click', (e) => { if (el.getAttribute('href') === '#') e.preventDefault(); });
    try { el.href = await D.fileUrl(el.dataset.file); } catch { /* keep placeholder */ }
  });
}

function lightbox(url) {
  const lb = document.createElement('div');
  lb.className = 'lightbox';
  lb.innerHTML = `<img src="${esc(url)}" alt="Photo"><button class="icon-btn" aria-label="Close">${ic('close')}</button>`;
  lb.onclick = () => lb.remove();
  $('#overlay').append(lb);
}

// ---------- Composer ----------
function renderComposerArea() {
  const area = $('#composerArea');
  const c = conv(S.open);
  if (!area || !c) return;
  if (c.type === 'channel' && !isMemberOf(S.channels.get(c.id) || c)) {
    area.innerHTML = `<div class="join-bar"><span>You're viewing <b>#${esc(c.name)}</b></span><button class="btn primary small" data-act="join">Join channel</button></div>`;
    return;
  }
  if (c.type === 'channel' && c.readOnly) {
    area.innerHTML = '<div class="join-bar">Only admins post here. Reply in a thread.</div>';
    return;
  }
  if (area.querySelector('#composer')) { renderAboveBar(); return; }
  area.innerHTML = composerHtml('composer', c.type === 'channel' ? `Message #${c.name}` : 'Message', c.type === 'channel');
  wireComposer(area, 'composer', { thread: false });
  renderAboveBar();
}

function composerHtml(id, placeholder, flat) {
  return `<div class="composer-wrap ${flat ? 'flat' : ''}">
    <div class="above"></div><div class="mention-menu" hidden></div>
    <form class="composer" id="${id}">
      <div class="field-box">
        <button type="button" class="icon-btn" data-c="emoji" aria-label="Emoji" title="Emoji">${ic('smile')}</button>
        <textarea rows="1" name="text" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}" autocomplete="off"></textarea>
        <button type="button" class="icon-btn" data-c="attach" aria-label="Attach a file" title="Photo, video or document">${ic('clip')}</button>
        <input type="file" hidden multiple>
      </div>
      <button class="send" type="submit" aria-label="Record a voice note" data-c="send">${ic('mic')}</button>
    </form></div>`;
}

function renderAboveBar(area = $('#composerArea')) {
  const above = area?.querySelector('.above');
  if (!above) return;
  if (S.editing) {
    above.innerHTML = `<div class="bar-above"><div><b style="color:var(--brand)">Editing message</b></div><button class="icon-btn" data-c="cancel-edit" aria-label="Cancel editing">${ic('close')}</button></div>`;
  } else if (S.replyTo) {
    above.innerHTML = `<div class="bar-above"><div><b style="color:var(--brand)">Replying to ${esc(S.replyTo.from === S.uid ? 'yourself' : nameOf(S.replyTo.from))}</b> · ${esc(S.replyTo.text)}</div><button class="icon-btn" data-c="cancel-reply" aria-label="Cancel reply">${ic('close')}</button></div>`;
  } else above.innerHTML = '';
}

function wireComposer(root, id, { thread }) {
  const form = root.querySelector(`#${id}`);
  const ta = form.querySelector('textarea');
  const sendBtn = form.querySelector('.send');
  const fileInput = form.querySelector('input[type=file]');
  const menu = root.querySelector('.mention-menu');
  let mention = null;

  const setSendIcon = () => {
    const hasText = ta.value.trim().length > 0 || S.editing;
    sendBtn.innerHTML = hasText ? ic('send') : ic('mic');
    sendBtn.setAttribute('aria-label', hasText ? 'Send' : 'Record a voice note');
  };
  const autosize = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`; };

  ta.addEventListener('input', () => {
    autosize(); setSendIcon();
    if (ta.value.trim()) D.setTyping(S.open, S.uid);
    // @mentions
    const upto = ta.value.slice(0, ta.selectionStart);
    const m = /(^|\s)@([\p{L}\p{N}._ -]{0,24})$/u.exec(upto);
    const c = conv(S.open);
    if (m && c) {
      const q = m[2].toLowerCase();
      const pool = c.type === 'channel' ? [...S.users.values()] : c.members.map((u) => ({ uid: u, ...user(u) }));
      const items = pool.filter((u) => u.uid !== S.uid && u.displayName && u.displayName.toLowerCase().includes(q)).slice(0, 8);
      if (c.type !== 'dm' && 'all'.startsWith(q)) items.unshift({ uid: 'all', displayName: 'all', title: 'Notify everyone here' });
      if (items.length) {
        mention = { items, index: 0, start: upto.length - m[2].length - 1 };
        menu.innerHTML = items.map((u, i) => `<button type="button" data-pick="${i}" class="${i === 0 ? 'on' : ''}">${u.uid === 'all' ? '<span class="avatar xs group" style="background:var(--gold)">@</span>' : avatarHtml(u.uid, 'xs')}<span><b>${esc(u.displayName)}</b> <small>${esc(u.title || '')}</small></span></button>`).join('');
        menu.hidden = false;
        return;
      }
    }
    mention = null; menu.hidden = true;
  });
  const pick = (i) => {
    const u = mention.items[i];
    const before = ta.value.slice(0, mention.start);
    const after = ta.value.slice(ta.selectionStart);
    ta.value = `${before}@${u.displayName} ${after}`;
    const pos = before.length + u.displayName.length + 2;
    ta.setSelectionRange(pos, pos);
    mention = null; menu.hidden = true; ta.focus(); setSendIcon();
  };
  menu.addEventListener('mousedown', (e) => { const b = e.target.closest('[data-pick]'); if (b) { e.preventDefault(); pick(Number(b.dataset.pick)); } });
  ta.addEventListener('keydown', (e) => {
    if (mention && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) {
      e.preventDefault();
      if (e.key === 'Escape') { mention = null; menu.hidden = true; return; }
      if (e.key === 'Enter' || e.key === 'Tab') return pick(mention.index);
      mention.index = (mention.index + (e.key === 'ArrowDown' ? 1 : -1) + mention.items.length) % mention.items.length;
      menu.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', i === mention.index));
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && wide.matches) { e.preventDefault(); form.requestSubmit(); }
    if (e.key === 'Escape' && (S.replyTo || S.editing)) { S.replyTo = null; S.editing = null; ta.value = ''; renderAboveBar(root); setSendIcon(); }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = ta.value.trim();
    if (!text && !S.editing) return startRecording(root, { thread });
    const c = conv(S.open);
    if (S.editing) {
      const ed = S.editing;
      S.editing = null; renderAboveBar(root);
      ta.value = ''; autosize(); setSendIcon();
      if (text && text !== ed.text) D.editMsg(ed.path, text).catch((err) => toast(err.message));
      return;
    }
    ta.value = ''; autosize(); setSendIcon(); menu.hidden = true;
    const content = { text, mentions: detectMentions(text, c) };
    if (!thread && S.replyTo) content.reply = { id: S.replyTo.id, from: S.replyTo.from, text: S.replyTo.text.slice(0, 120) };
    S.replyTo = null; renderAboveBar(root);
    try {
      if (thread) await D.sendReply(S.open, S.thread, S.uid, content);
      else await D.sendMessage(S.open, S.uid, content);
    } catch (err) {
      toast(/permission/i.test(err.message) ? 'You can\'t post here.' : 'Not sent. Check your connection.');
      ta.value = text; setSendIcon();
    }
  });

  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-c]');
    if (!b) return;
    const a = b.dataset.c;
    if (a === 'attach') fileInput.click();
    if (a === 'emoji') { insertAtCursor(ta, '🤲'); setSendIcon(); }
    if (a === 'cancel-reply') { S.replyTo = null; renderAboveBar(root); }
    if (a === 'cancel-edit') { S.editing = null; ta.value = ''; autosize(); setSendIcon(); renderAboveBar(root); }
  });
  fileInput.addEventListener('change', () => {
    const files = [...fileInput.files];
    fileInput.value = '';
    files.forEach((f) => sendFile(root, f, { thread }));
  });
  // Paste or drop files into the chat.
  ta.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); files.forEach((f) => sendFile(root, f, { thread })); }
  });
  root.closest('.pane')?.addEventListener('dragover', (e) => e.preventDefault());
  root.closest('.pane')?.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length && S.open) { e.preventDefault(); files.forEach((f) => sendFile(root, f, { thread })); }
  });
  form.setText = (t) => { ta.value = t; autosize(); setSendIcon(); ta.focus(); };
  setSendIcon();
}

function insertAtCursor(ta, text) {
  const s = ta.selectionStart ?? ta.value.length;
  ta.value = ta.value.slice(0, s) + text + ta.value.slice(ta.selectionEnd ?? s);
  ta.setSelectionRange(s + text.length, s + text.length);
  ta.focus();
}

async function sendFile(root, file, { thread, voiceDur } = {}) {
  const cid = S.open;
  const parent = S.thread;
  if (file.size > 200 * 1024 * 1024) return toast('Files up to 200 MB can be sent.');
  const above = root.querySelector('.above');
  const bar = document.createElement('div');
  bar.className = 'uploading';
  bar.innerHTML = `<span>${ic(voiceDur ? 'mic' : 'clip', 'width="16" height="16"')}</span><span style="max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(voiceDur ? 'Voice message' : file.name)}</span><progress max="1" value="0"></progress><button class="icon-btn" style="width:28px;height:28px" aria-label="Cancel upload">${ic('close', 'width="16" height="16"')}</button>`;
  above.after(bar);
  const kind = voiceDur ? 'voice' : /^image\/(png|jpe?g|gif|webp)$/.test(file.type) ? 'image' : 'file';
  const up = D.uploadFile(cid, file, (p) => { bar.querySelector('progress').value = p; }, voiceDur ? `voice-${Date.now()}.webm` : undefined);
  bar.querySelector('button').onclick = () => up.cancel();
  try {
    const meta = await up.promise;
    if (voiceDur) meta.dur = Math.round(voiceDur);
    const content = { kind, file: meta };
    if (thread) await D.sendReply(cid, parent, S.uid, content);
    else await D.sendMessage(cid, S.uid, content);
  } catch (err) {
    if (!/cancel/i.test(err.code || err.message)) toast(/unauthorized|permission/i.test(err.code || err.message) ? 'You can\'t send files here.' : 'Upload failed. Check your connection.');
  } finally {
    bar.remove();
  }
}

// Voice notes (WhatsApp style: tap the mic, speak, send).
let rec = null;
async function startRecording(root, opts) {
  if (rec) return;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return toast('Voice notes need a newer browser.');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch {
    return toast('Allow the microphone to record voice notes.');
  }
  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
  const mr = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : {});
  const chunks = [];
  mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const started = Date.now();
  rec = { mr, stream, send: false };
  const form = root.querySelector('form');
  const box = form.querySelector('.field-box');
  box.hidden = true;
  const ui = document.createElement('div');
  ui.className = 'recording';
  ui.innerHTML = `<i class="dot"></i><span>0:00</span><button type="button" class="icon-btn" aria-label="Delete recording" title="Delete">${ic('trash')}</button>`;
  box.after(ui);
  const sendBtn = form.querySelector('.send');
  sendBtn.innerHTML = ic('send');
  sendBtn.setAttribute('aria-label', 'Send voice note');
  const tick = setInterval(() => { ui.querySelector('span').textContent = fmtDur((Date.now() - started) / 1000); }, 250);
  const finish = (send) => {
    rec.send = send;
    if (mr.state !== 'inactive') mr.stop();
  };
  ui.querySelector('button').onclick = () => finish(false);
  const onSubmit = (e) => { e.preventDefault(); e.stopImmediatePropagation(); finish(true); };
  form.addEventListener('submit', onSubmit, { capture: true, once: true });
  mr.onstop = () => {
    clearInterval(tick);
    stream.getTracks().forEach((t) => t.stop());
    ui.remove();
    box.hidden = false;
    form.removeEventListener('submit', onSubmit, { capture: true });
    sendBtn.innerHTML = ic('mic');
    const dur = (Date.now() - started) / 1000;
    const send = rec.send;
    rec = null;
    if (send && dur > 0.8) {
      const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
      sendFile(root, new File([blob], 'voice.webm', { type: blob.type }), { ...opts, voiceDur: dur });
    }
  };
  mr.start(250);
}

// Voice playback
let player = null;
function stopVoice() {
  if (player) { player.audio.pause(); player = null; }
  document.querySelectorAll('.voice .play').forEach((b) => { b.innerHTML = ic('play'); });
  document.querySelectorAll('.voice .track i.on').forEach((i) => i.classList.remove('on'));
}
async function toggleVoice(key, el) {
  if (player && player.key === key) { stopVoice(); return; }
  stopVoice();
  const wrap = el.closest('.voice');
  let url;
  try { url = await D.fileUrl(wrap.dataset.voice); } catch { return toast('Voice message unavailable.'); }
  const audio = new Audio(url);
  player = { key, audio };
  const bars = [...wrap.querySelectorAll('.track i')];
  const label = wrap.querySelector('small');
  const total = label.textContent;
  audio.ontimeupdate = () => {
    const p = audio.duration && isFinite(audio.duration) ? audio.currentTime / audio.duration : audio.currentTime / (msgIndex.get(key)?.file?.dur || 1);
    const on = Math.round(p * bars.length);
    bars.forEach((b, i) => b.classList.toggle('on', i < on));
    label.textContent = fmtDur(audio.currentTime);
  };
  audio.onended = () => { stopVoice(); label.textContent = total; };
  el.innerHTML = ic('pause');
  audio.play().catch(() => { stopVoice(); toast('Could not play this voice message.'); });
}

// ---------- Message interactions ----------
async function onMessageClick(e) {
  const t = e.target;
  const play = t.closest('[data-play]');
  if (play) return toggleVoice(play.dataset.play, play);
  const reactBtn = t.closest('[data-react]');
  if (reactBtn) {
    const m = msgIndex.get(reactBtn.dataset.key);
    if (!m) return;
    const mine = (m.reactions || {})[S.uid];
    const emoji = reactBtn.dataset.react;
    S.actionFor = null;
    D.react(pathOf(m), S.uid, mine === emoji ? null : emoji).catch(() => toast('Could not react.'));
    return;
  }
  const th = t.closest('[data-thread]');
  if (th) { S.actionFor = null; return openThread(th.dataset.thread); }
  const rep = t.closest('[data-reply]');
  if (rep) {
    const m = msgIndex.get(rep.dataset.reply);
    S.replyTo = { id: m.id, from: m.from, text: D.snippet(m) };
    S.actionFor = null;
    renderMsgs();
    renderAboveBar();
    $('#composer textarea')?.focus();
    return;
  }
  const ed = t.closest('[data-edit]');
  if (ed) {
    const m = msgIndex.get(ed.dataset.edit);
    S.editing = { path: pathOf(m), text: m.text };
    S.actionFor = null;
    renderMsgs();
    renderAboveBar();
    $('#composer')?.setText(m.text);
    return;
  }
  const del = t.closest('[data-del]');
  if (del) {
    const m = msgIndex.get(del.dataset.del);
    S.actionFor = null;
    if (await confirmSheet('Delete this message?', 'It will be deleted for everyone in this chat.', 'Delete for everyone', true)) {
      D.deleteMsg(pathOf(m)).catch(() => toast('Could not delete.'));
    } else renderMsgs();
    return;
  }
  const jump = t.closest('[data-jump]');
  if (jump) {
    const el = document.getElementById(`m-${jump.dataset.jump}`);
    if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
    else toast('That message is further up. Load earlier messages.');
    return;
  }
  if (t.closest('a, video, .media, .voice, .reacts')) return;
  const msgEl = t.closest('[data-msg]');
  if (msgEl) {
    const key = msgEl.dataset.msg;
    S.actionFor = S.actionFor === key ? null : key;
    if (key.startsWith('r:')) renderThread(); else renderMsgs();
  } else if (S.actionFor) {
    S.actionFor = null;
    renderMsgs(); renderThread();
  }
}

$('#convPane').addEventListener('click', async (e) => {
  const a = e.target.closest('[data-act]')?.dataset.act;
  if (a === 'back') { S.settingsView = null; closeConv(); return; }
  if (a === 'info') return convInfoSheet();
  if (a === 'call') return toast('Voice and video calls are coming in the next update.');
  if (a === 'more') {
    S.msgLimit += 60;
    unsub('msgs');
    subs.msgs = D.watchMsgs(S.open, S.msgLimit, onMsgs);
    return;
  }
  if (a === 'join') {
    try { await D.joinChannel(S.open, S.uid); toast('Joined. You\'ll get notifications from this channel.'); } catch { toast('Could not join.'); }
    return;
  }
  if (a === 'link-device') return linkDevice();
  if (a === 'remove-device') return removeDevice(e.target.closest('[data-id]').dataset.id);
  if (a === 'remove-others') return removeOthers();
  if (e.target.closest('#msgs')) onMessageClick(e);
});

// ---------- Threads (channels) ----------
function openThread(mid) {
  unsub('thread'); unsub('threadRoot');
  S.thread = mid;
  S.threadRoot = S.msgs.find((m) => m.id === mid) || null;
  S.replies = [];
  const pane = $('#threadPane');
  const c = conv(S.open);
  pane.innerHTML = `<header class="convbar"><button class="icon-btn" data-t="close" aria-label="Back to channel">${ic(wide.matches ? 'close' : 'back')}</button>
      <div class="who"><b>Thread</b><small># ${esc(c.name)}</small></div></header>
    <div class="messages channel" id="threadMsgs"></div><div id="threadComposer"></div>`;
  const tc = $('#threadComposer');
  tc.innerHTML = composerHtml('tcomposer', 'Reply in thread', true);
  wireComposer(tc, 'tcomposer', { thread: true });
  subs.thread = D.watchReplies(S.open, mid, (snap) => {
    S.replies = snap.docs.map((d) => ({ id: d.id, parent: mid, pending: d.metadata.hasPendingWrites, ...d.data() }));
    renderThread(true);
  });
  subs.threadRoot = D.watchMsg(S.open, mid, (snap) => { if (snap.exists()) { S.threadRoot = { id: snap.id, ...snap.data() }; renderThreadRoot(); } });
  setPane('thread');
  renderThread(true);
}
function renderThreadRoot() { renderThread(); }
function renderThread(stick = false) {
  const box = $('#threadMsgs');
  const c = conv(S.open);
  if (!box || !c || !S.threadRoot) return;
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  const root = { ...S.threadRoot, key: `m:${S.threadRoot.id}` };
  msgIndex.set(root.key, root);
  box.innerHTML = `<div class="thread-root">${cmsgHtml(root, 0, [root], c, true)}</div>
    <div class="reply-count">${S.replies.length} ${S.replies.length === 1 ? 'reply' : 'replies'}</div>${messagesHtml(S.replies, c, true)}`;
  hydrate(box);
  if (stick || near) box.scrollTop = box.scrollHeight;
}
$('#threadPane').addEventListener('click', (e) => {
  if (e.target.closest('[data-t="close"]')) {
    unsub('thread'); unsub('threadRoot');
    S.thread = null; S.replies = [];
    setPane('conv');
    return;
  }
  if (e.target.closest('#threadMsgs')) onMessageClick(e);
});

// ---------- New chat / group / channel ----------
function peoplePicker(box, { multi, onPick }) {
  const others = [...S.users.values()].filter((u) => u.uid !== S.uid).sort((a, b) => a.displayName.localeCompare(b.displayName));
  box.insertAdjacentHTML('beforeend', `<div class="search" style="margin:0">${ic('search')}<input placeholder="Search people" aria-label="Search people"></div>
    <div class="pick">${others.map((u) => `<label class="row" data-name="${esc((u.displayName + ' ' + u.username + ' ' + (u.title || '')).toLowerCase())}">
      ${multi ? `<input type="checkbox" value="${u.uid}">` : ''}${avatarHtml(u.uid)}<span class="row-main"><b>${esc(u.displayName)}</b><span class="preview">${esc(u.title || '@' + u.username)}</span></span>
      ${multi ? '' : `<button class="sr" data-uid="${u.uid}">Message</button>`}</label>`).join('') || '<p class="list-empty">Nobody else has joined yet. Share the team code with your colleagues.</p>'}</div>`);
  const input = box.querySelector('.search input');
  input.addEventListener('input', () => {
    const q = input.value.toLowerCase();
    box.querySelectorAll('.pick .row').forEach((r) => { r.hidden = !r.dataset.name.includes(q); });
  });
  if (!multi) box.querySelector('.pick').addEventListener('click', (e) => { const r = e.target.closest('.row'); if (r) onPick(r.querySelector('[data-uid]').dataset.uid); });
}

function newChatSheet() {
  sheet((box, close) => {
    box.insertAdjacentHTML('beforeend', '<h2>New chat</h2>');
    peoplePicker(box, { multi: false, onPick: (uid) => { close(); openDm(uid); } });
    box.insertAdjacentHTML('beforeend', `<div class="actions"><button class="btn ghost" data-a="group">${ic('people')} New group</button><button class="btn ghost" data-a="notes">${ic('edit')} Notes to self</button></div>`);
    box.addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'group') { close(); newGroupSheet(); }
      if (a === 'notes') { close(); openDm(S.uid); }
    });
  });
}

function newGroupSheet() {
  sheet((box, close) => {
    box.insertAdjacentHTML('beforeend', `<h2>New group</h2><label class="field">Group name<input id="gName" maxlength="60" placeholder="e.g. Ramadan Transmission 1448"></label>`);
    peoplePicker(box, { multi: true });
    box.insertAdjacentHTML('beforeend', `<p class="error" id="gErr"></p><div class="actions"><button class="btn ghost" data-a="cancel">Cancel</button><button class="btn primary" data-a="create">Create group</button></div>`);
    box.addEventListener('click', async (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'cancel') close();
      if (a !== 'create') return;
      const name = $('#gName').value.trim();
      const members = [...box.querySelectorAll('.pick input:checked')].map((i) => i.value);
      if (!name) { $('#gErr').textContent = 'Give the group a name.'; return; }
      if (!members.length) { $('#gErr').textContent = 'Pick at least one person.'; return; }
      e.target.disabled = true;
      try { const id = await D.createGroup(S.uid, name, members); close(); S.tab = 'chats'; renderNav(); setTimeout(() => openConv(id), 300); }
      catch (err) { $('#gErr').textContent = err.message; e.target.disabled = false; }
    });
  });
}

function newChannelSheet() {
  sheet((box, close) => {
    box.insertAdjacentHTML('beforeend', `<h2>Create a channel</h2><p>Channels are open to everyone at Madani Channel. Use them for a department or a project.</p>
      <label class="field">Name<input id="cName" maxlength="40" placeholder="e.g. promo, news-desk, ramadan-1448"></label>
      <label class="field">What is it about? <small>(optional)</small><input id="cTopic" maxlength="200" placeholder="e.g. Promos, trailers and on-air graphics"></label>
      <p class="error" id="cErr"></p><div class="actions"><button class="btn ghost" data-a="cancel">Cancel</button><button class="btn primary" data-a="create">Create channel</button></div>`);
    box.addEventListener('click', async (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'cancel') close();
      if (a !== 'create') return;
      try { const id = await D.createChannel(S.uid, $('#cName').value, $('#cTopic').value); close(); S.tab = 'channels'; renderNav(); setTimeout(() => openConv(id), 300); }
      catch (err) { $('#cErr').textContent = /permission/i.test(err.message) ? 'Could not create the channel.' : err.message; }
    });
  });
}

function convInfoSheet() {
  const c = conv(S.open);
  if (!c) return;
  const canEdit = c.type !== 'dm' && c.createdBy === S.uid;
  sheet((box, close) => {
    const members = c.type === 'channel' ? (c.members || []) : c.members;
    box.insertAdjacentHTML('beforeend', `<div style="display:flex;gap:12px;align-items:center">${convAvatar(c, 'lg')}<div><h2>${c.type === 'channel' ? '# ' : ''}${esc(convTitle(c))}</h2>
        <p>${c.type === 'dm' ? esc(user(dmPeer(c)).title || '@' + user(dmPeer(c)).username) : esc(c.topic || `${members.length} members`)}</p></div></div>
      ${c.type !== 'dm' ? `<div class="section-label" style="padding:4px 0 0">${members.length} ${c.type === 'channel' ? 'joined' : 'members'}</div>
        <div class="pick">${members.map((u) => `<div class="row">${avatarHtml(u, 'sm')}<span class="row-main"><b>${esc(nameOf(u))}</b><span class="preview">${esc(user(u).title || '')}</span></span></div>`).join('')}</div>` : ''}
      ${canEdit ? `<label class="field">Pinned note<input id="pinNote" maxlength="300" value="${esc(c.pinned || '')}" placeholder="e.g. Deadlines sheet is updated every Monday"></label>` : ''}
      <div class="actions">
        ${c.type === 'channel' && isMemberOf(S.channels.get(c.id) || c) ? '<button class="btn danger" data-a="leave">Leave channel</button>' : ''}
        ${canEdit ? '<button class="btn primary" data-a="save">Save</button>' : '<button class="btn ghost" data-a="close">Close</button>'}
      </div>`);
    box.addEventListener('click', async (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'close') close();
      if (a === 'save') { await D.setPinned(c.id, $('#pinNote').value.trim()).catch(() => toast('Could not save.')); close(); }
      if (a === 'leave') { await D.leaveChannel(c.id, S.uid).catch(() => toast('Could not leave.')); close(); closeConv(); }
    });
  });
}

// ---------- Settings ----------
function settingsList() {
  const me = user(S.uid);
  const theme = (() => { try { return localStorage.getItem('mm.theme') || 'system'; } catch { return 'system'; } })();
  const notif = 'Notification' in window ? Notification.permission : 'unsupported';
  return `<div class="list">
    <div class="me-card">${avatarHtml(S.uid, 'lg')}<div><b>${esc(me.displayName)}</b><small>${esc(me.title || '')}${me.title ? ' · ' : ''}@${esc(me.username || '')}</small></div></div>
    <button class="setting" data-set="profile"><span class="s-icon">${ic('user')}</span><div><b>Profile</b><small>Your name and department</small></div></button>
    <button class="setting" data-set="devices"><span class="s-icon">${ic('laptop')}</span><div><b>Linked devices</b><small>Use the messenger on your computer with a QR code</small></div><span class="val">${S.devices.length || ''}</span></button>
    ${native ? '' : `<button class="setting" data-set="notify"><span class="s-icon">${ic('bell')}</span><div><b>Notifications</b><small>${notif === 'granted' ? 'On for this browser' : notif === 'denied' ? 'Blocked. Allow them in the browser\'s site settings.' : notif === 'unsupported' ? 'Not supported in this browser' : 'Tap to turn on'}</small></div></button>`}
    <div class="setting"><span class="s-icon">${ic('moon')}</span><div><b>Appearance</b><small>Light, dark or follow the device</small></div></div>
    <div class="theme-pick chips" role="group" aria-label="Appearance">${['system', 'light', 'dark'].map((t) => `<button class="chip" data-set="theme:${t}" aria-pressed="${theme === t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div>
    <button class="setting" data-set="signout"><span class="s-icon danger">${ic('logout')}</span><div><b style="color:var(--danger)">Sign out</b><small>On this device only</small></div></button>
    <p class="fine">${ic('lock')} ${APP_NAME} ${usingEmulators ? '· test mode' : ''}</p>
  </div>`;
}

async function settingsAction(a) {
  if (a === 'profile') return profileSheet();
  if (a === 'devices') return openDevices();
  if (a === 'notify') {
    if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
    return renderList();
  }
  if (a.startsWith('theme:')) {
    const t = a.slice(6);
    try { if (t === 'system') localStorage.removeItem('mm.theme'); else localStorage.setItem('mm.theme', t); } catch { /* storage unavailable */ }
    if (t === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
    return renderList();
  }
  if (a === 'signout') {
    if (await confirmSheet('Sign out on this device?', 'Your chats stay safe on the server. Sign in again with your username and PIN, or a QR code.', 'Sign out', true)) {
      await D.removeDevice(S.uid, D.deviceId()).catch(() => {});
      await D.signOutHere();
    }
  }
}

function profileSheet() {
  const me = user(S.uid);
  sheet((box, close) => {
    box.insertAdjacentHTML('beforeend', `<h2>Your profile</h2>
      <label class="field">Full name<input id="pName" maxlength="60" value="${esc(me.displayName)}"></label>
      <label class="field">Department or role<input id="pTitle" maxlength="60" value="${esc(me.title || '')}" placeholder="e.g. Promo department"></label>
      <p class="error" id="pErr"></p><div class="actions"><button class="btn ghost" data-a="cancel">Cancel</button><button class="btn primary" data-a="save">Save</button></div>`);
    box.addEventListener('click', async (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'cancel') close();
      if (a !== 'save') return;
      const name = $('#pName').value.trim();
      if (!name) { $('#pErr').textContent = 'Type your name.'; return; }
      try { await D.updateProfile(S.uid, name, $('#pTitle').value.trim()); close(); toast('Profile saved'); } catch (err) { $('#pErr').textContent = err.message; }
    });
  });
}

function openDevices() {
  S.settingsView = 'devices';
  closeConv(false);
  renderSettingsPane();
  setPane('conv');
}

function renderSettingsPane() {
  if (!S.uid) return;
  if (S.settingsView !== 'devices') {
    if (wide.matches && S.tab === 'settings' && !S.open) {
      $('#convPane').innerHTML = `<div class="messages"><div class="conv-empty">${ic('gear', 'width="50" height="50" style="color:var(--brand);opacity:.75"')}<b>Settings</b><span>Pick a setting on the left.</span></div></div>`;
    }
    return;
  }
  const did = D.deviceId();
  const list = [...S.devices].sort((a, b) => (b.id === did) - (a.id === did) || ms(b.lastActive) - ms(a.lastActive));
  $('#convPane').innerHTML = `<header class="convbar"><button class="icon-btn back-btn" data-act="back" aria-label="Back">${ic('back')}</button><div class="who"><b>Linked devices</b></div></header>
    <div class="scroll">
      <div class="hero"><span class="big">${ic('laptop')}</span><b>Use ${APP_NAME} on your computer</b>
        <p>Open ${esc(location.host)} on the computer and scan the QR code it shows. Your chats stay in sync.</p>
        <button class="btn primary" data-act="link-device">${ic('qr')} Link a device</button></div>
      <div class="section-label">Signed in on</div>
      ${list.map((d) => `<div class="device-row" data-id="${esc(d.id)}"><span class="d-icon">${ic(isPhoneDevice(d.name) ? 'mobile' : 'laptop')}</span>
        <div class="t"><b>${esc(d.name)}${d.id === did ? ' (this device)' : ''}</b>
          <small class="${d.id === did || Date.now() - ms(d.lastActive) < 150e3 ? 'on' : ''}">${d.id === did ? 'Active now' : `Last active ${esc(listTime(d.lastActive))}`}${d.via === 'qr' ? ` · linked from ${esc(d.by || 'phone')}` : ''}</small></div>
        ${d.id === did ? '' : '<button class="btn danger small" data-act="remove-device">Sign out</button>'}</div>`).join('')}
      ${list.length > 1 ? '<div style="padding:8px 16px"><button class="btn ghost small" data-act="remove-others">Sign out all other devices</button></div>' : ''}
      <p class="fine">${ic('lock')} Each QR code works once, for one minute. Only you can approve a new device.</p>
    </div>`;
}

async function removeDevice(id) {
  const d = S.devices.find((x) => x.id === id);
  if (!d) return;
  if (await confirmSheet(`Sign out ${d.name}?`, 'It will need a new QR code or the PIN to open your chats again.', 'Sign out', true)) {
    D.removeDevice(S.uid, id).then(() => toast(`Signed out: ${d.name}`)).catch(() => toast('Could not sign it out.'));
  }
}
async function removeOthers() {
  if (!(await confirmSheet('Sign out all other devices?', 'Only this device stays signed in.', 'Sign out others', true))) return;
  const did = D.deviceId();
  await Promise.all(S.devices.filter((d) => d.id !== did).map((d) => D.removeDevice(S.uid, d.id))).catch(() => {});
  toast('Other devices signed out');
}

// ---------- Link a device: scan the computer's QR ----------
async function linkDevice() {
  const text = native && native.scanQr ? await nativeScan() : await scanQr();
  if (text) await approveFromText(text);
}

function nativeScan() {
  return new Promise((resolve) => {
    window.MadaniApp = { ...(window.MadaniApp || {}), onScan: (t) => resolve(t || null) };
    native.scanQr();
  });
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (src.includes('jsqr') && window.jsQR) return resolve();
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('Could not load the scanner.'));
    document.head.append(s);
  });
}

function scanQr() {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'scanner';
    wrap.innerHTML = `<header class="convbar"><button class="icon-btn" data-x aria-label="Close">${ic('close')}</button><div class="who"><b>Scan QR code</b></div></header>
      <div class="scan-view"><video playsinline muted></video><div class="scan-frame"><div class="scan-line"></div></div></div>
      <div class="scan-hint" id="scanHint">Point your phone at the QR code on the computer screen</div>`;
    $('#overlay').append(wrap);
    let stream = null, timer = null, done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (stream) stream.getTracks().forEach((t) => t.stop());
      wrap.remove();
      resolve(v);
    };
    wrap.querySelector('[data-x]').onclick = () => finish(null);
    (async () => {
      const video = wrap.querySelector('video');
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (done) { stream.getTracks().forEach((t) => t.stop()); return; }
        video.srcObject = stream;
        await video.play();
        let detector = null;
        if ('BarcodeDetector' in window) { try { detector = new window.BarcodeDetector({ formats: ['qr_code'] }); } catch { detector = null; } }
        if (!detector) await loadScript('/vendor/jsqr.js');
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const tick = async () => {
          if (done) return;
          if (video.readyState >= 2 && video.videoWidth) {
            let text = null;
            if (detector) {
              try { const codes = await detector.detect(video); if (codes.length) text = codes[0].rawValue; } catch { /* keep trying */ }
            } else {
              const scale = Math.min(1, 640 / video.videoWidth);
              canvas.width = Math.round(video.videoWidth * scale);
              canvas.height = Math.round(video.videoHeight * scale);
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
              const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
              const code = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
              if (code) text = code.data;
            }
            if (text && D.parseLinkCode(text)) return finish(text);
          }
          timer = setTimeout(tick, 160);
        };
        tick();
      } catch {
        $('#scanHint').textContent = 'The camera is not available. Allow camera access for this app, then try again.';
      }
    })();
  });
}

async function approveFromText(text) {
  const link = D.parseLinkCode(text);
  if (!link) return toast('That is not a Madani Messenger QR code.');
  let info;
  try { info = await D.peekLink(link.id); } catch (err) { return toast(err.message); }
  const ok = await new Promise((resolve) => {
    sheet((box, close) => {
      box.insertAdjacentHTML('beforeend', `<h2>Link this computer?</h2>
        <div class="device-row"><span class="d-icon">${ic('laptop')}</span><div class="t"><b>${esc(info.device || 'Computer')}</b><small>Asking just now</small></div></div>
        <p>It will show all your chats and can send messages as you. You can sign it out from Linked devices at any time.</p>
        <div class="actions"><button class="btn ghost" data-a="no">Cancel</button><button class="btn primary" data-a="yes">Link device</button></div>`);
      box.addEventListener('click', (e) => { const a = e.target.closest('[data-a]')?.dataset.a; if (a) { close(); resolve(a === 'yes'); } });
    });
  });
  if (!ok) return;
  try {
    const res = await D.approveLink(link.id, link.code);
    toast(`Linked: ${res.device || 'computer'}`);
  } catch (err) { toast(err.message); }
}

function runPendingLink() {
  let href = null;
  try { href = sessionStorage.getItem('mm.pendingLink'); sessionStorage.removeItem('mm.pendingLink'); } catch { /* storage unavailable */ }
  if (href) approveFromText(href);
}

// Hooks for the Android app (tapping a notification opens the conversation).
window.MadaniApp = {
  ...(window.MadaniApp || {}),
  openConv: (cid) => { if (S.uid && conv(cid)) openConv(cid); },
  back: () => {
    const sheetOpen = document.querySelector('#overlay .sheet-wrap, #overlay .lightbox, #overlay .scanner');
    if (sheetOpen) { sheetOpen.remove(); return true; }
    if (S.thread) { unsub('thread'); unsub('threadRoot'); S.thread = null; setPane('conv'); return true; }
    if (S.open || S.settingsView) { S.settingsView = null; closeConv(); return true; }
    if (S.tab !== 'chats') { S.tab = 'chats'; renderNav(); renderList(); return true; }
    return false;
  },
};

takeLinkFromUrl();
