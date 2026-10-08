// Small helpers: icons, escaping, dates, device names.

const ICONS = {
  chats: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4h0A1.5 1.5 0 0 1 4 14.5z"/>',
  hash: '<path d="M9 3 7 21M17 3l-2 18M4 8.5h17M3 15.5h17"/>',
  phone: '<path d="M5 4h3.5l1.5 4.5-2.2 1.4a11 11 0 0 0 6.3 6.3l1.4-2.2L20 15.5V19a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  more: '<circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/>',
  video: '<rect x="3" y="6" width="13" height="12" rx="2.5"/><path d="m16 10.5 5-3v9l-5-3z"/>',
  send: '<path d="M4 12 20 4l-6 16-2.5-6.5z"/><path d="M11.5 13.5 20 4"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  clip: '<path d="m20 11.5-8.2 8.2a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L9.4 17.3a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8"/>',
  smile: '<circle cx="12" cy="12" r="9"/><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01"/>',
  camera: '<path d="M4 8h3l1.5-2.5h7L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/>',
  play: '<path d="M7 4.5v15L19.5 12z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M7 4h3.5v16H7zM13.5 4H17v16h-3.5z" fill="currentColor" stroke="none"/>',
  tick: '<path d="m4 12.5 4.5 4.5L18 7.5"/>',
  ticks: '<path d="m2 12.5 4.5 4.5L16 7.5M10.5 15.5 12 17l9.5-9.5"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4.5l3 1.5"/>',
  pin: '<path d="M9 4h6l-1 5 3.5 3.5H6.5L10 9zM12 12.5V20"/>',
  qr: '<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2.5v2.5H14zM17.5 17.5H20V20h-2.5zM14 18.5h2"/>',
  laptop: '<rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/>',
  mobile: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  logout: '<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 16l-4-4 4-4M6 12h10"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  people: '<circle cx="9" cy="8" r="3.2"/><path d="M3 19a6 6 0 0 1 12 0M16 4.8a3.2 3.2 0 0 1 0 6.4M21 19a6 6 0 0 0-3.5-5.4"/>',
  user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  reply: '<path d="M10 8 5 12.5l5 4.5M5 12.5h9a5 5 0 0 1 5 5V19"/>',
  thread: '<path d="M5 5h14v9H11l-4 3.5V14H5z"/><path d="M9 9h6"/>',
  file: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="m20 16-5-5-8.5 8.5"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" stroke="none"/>',
  download: '<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>',
};

export const ic = (name, extra = '') =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${ICONS[name] || ''}</svg>`;

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const $ = (sel, root = document) => root.querySelector(sel);

/** Firestore Timestamp | Date | number | null → milliseconds (pending server times count as now). */
export const ms = (t) => (t == null ? Date.now() : typeof t === 'number' ? t : t.toMillis ? t.toMillis() : +t);

const sameDay = (a, b) => { const x = new Date(a), y = new Date(b); return x.toDateString() === y.toDateString(); };
export const fmtTime = (t) => new Date(ms(t)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
export function dayLabel(t) {
  const d = ms(t);
  if (sameDay(d, Date.now())) return 'Today';
  if (sameDay(d, Date.now() - 864e5)) return 'Yesterday';
  const date = new Date(d);
  if (Date.now() - d < 6 * 864e5) return date.toLocaleDateString([], { weekday: 'long' });
  return date.toLocaleDateString([], { day: 'numeric', month: 'short', year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}
/** For chat lists: time today, "Yesterday", weekday or date. */
export function listTime(t) {
  const d = ms(t);
  return sameDay(d, Date.now()) ? fmtTime(d) : dayLabel(d);
}
export function lastSeenText(t) {
  if (!t) return 'offline';
  const d = ms(t);
  if (Date.now() - d < 150e3) return 'online';
  return `last seen ${sameDay(d, Date.now()) ? 'today' : dayLabel(d).toLowerCase()} at ${fmtTime(d)}`;
}
export const isOnline = (t) => Boolean(t) && Date.now() - ms(t) < 150e3;

export function fmtSize(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}
export const fmtDur = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export const randomId = (bytes = 15) =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** "Chrome on Windows", "Madani Messenger app · Galaxy A54" */
export function describeDevice(ua = navigator.userAgent) {
  const app = /MadaniMessenger\/[\d.]+(?: \(([^)]{1,60})\))?/.exec(ua);
  if (app) return `Madani Messenger app${app[1] ? ` · ${app[1]}` : ''}`;
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iPhone'
    : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'a device';
  return `${browser} on ${os}`;
}
export const isPhoneDevice = (name) => /app|Android|iPhone/.test(name);

// Avatar colours: readable with white initials in both themes.
const COLORS = ['#0B6B4D', '#2F6FDB', '#8A4FD8', '#D9692B', '#C2412D', '#B7862B', '#0E8A8A', '#5B6B2F', '#B2457A', '#3F5BA9'];
export const colorFor = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return COLORS[h % COLORS.length]; };
export const initials = (name) => String(name || '?').trim().split(/\s+/).map((w) => [...w][0]).slice(0, 2).join('').toUpperCase();

/** Urdu / Arabic script → right-to-left bubble. */
export const isRtl = (s) => /^[\s\d\p{P}]*[؀-ۿ]/u.test(String(s || ''));
