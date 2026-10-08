/**
 * Madani Messenger — server-side pieces that apps must not do themselves:
 *   approveLink  — a signed-in phone approves a computer that shows a QR code
 *   pushMessage  — notifications for new messages and thread replies
 */
import { createHash } from 'node:crypto';
import { setGlobalOptions } from 'firebase-functions/v2';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { getMessaging } from 'firebase-admin/messaging';

// Mumbai is the closest Google region to Pakistan. Keep it the same as the Firestore location.
setGlobalOptions({ region: 'asia-south1', maxInstances: 10 });

initializeApp();
const db = getFirestore();

const LINK_TTL_MS = 60_000;
const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');

// ---------- Link a computer with a QR code ----------

export const approveLink = onCall(async (req) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in on your phone first.');
  const me = await db.doc(`users/${uid}`).get();
  if (!me.exists) throw new HttpsError('permission-denied', 'Only members can link devices.');

  const id = String(req.data?.id || '');
  const code = String(req.data?.code || '');
  const phone = String(req.data?.device || 'phone').slice(0, 80);
  if (!/^[A-Za-z0-9_-]{10,40}$/.test(id) || !code) throw new HttpsError('invalid-argument', 'This QR code is not valid.');

  const ref = db.doc(`links/${id}`);
  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.get('codeHash') !== sha256(code)) {
      throw new HttpsError('not-found', 'This QR code is not valid. Scan the code shown on the computer.');
    }
    const created = snap.get('createdAt')?.toMillis?.() || 0;
    if (snap.get('status') !== 'pending' || Date.now() - created > LINK_TTL_MS + 10_000) {
      throw new HttpsError('deadline-exceeded', 'This QR code has expired. Scan the new code on the computer.');
    }
    // A one-time sign-in token for the phone's account. Only the computer that created
    // the link (its anonymous account) can read it, and it is deleted once used.
    const token = await getAuth().createCustomToken(uid, { via: 'qr' });
    tx.update(ref, { status: 'approved', token, uid, by: phone, approvedAt: FieldValue.serverTimestamp() });
    return { device: snap.get('device') };
  });
  return result;
});

// ---------- Push notifications ----------

function snippet(m) {
  if (m.deleted) return 'Message deleted';
  if (m.kind === 'voice') return '🎤 Voice message';
  if (m.kind === 'image') return `📷 ${m.text || 'Photo'}`;
  if (m.kind === 'file') return `📎 ${m.file?.name || 'File'}`;
  return String(m.text || '').slice(0, 180);
}

async function tokensFor(uids) {
  const out = [];
  await Promise.all(uids.map(async (u) => {
    const devices = await db.collection(`users/${u}/devices`).where('fcm', '!=', null).get();
    devices.forEach((d) => out.push({ uid: u, ref: d.ref, token: d.get('fcm') }));
  }));
  return out;
}

async function notify(cid, msg, { threadOf = null } = {}) {
  const convSnap = await db.doc(`convs/${cid}`).get();
  if (!convSnap.exists) return;
  const conv = convSnap.data();
  const sender = (await db.doc(`users/${msg.from}`).get()).data() || {};
  const name = sender.displayName || sender.username || 'Someone';
  const mentions = Array.isArray(msg.mentions) ? msg.mentions : [];

  let recipients = (conv.members || []).filter((u) => u !== msg.from);
  if (threadOf) {
    // Thread replies go to people already in the thread, the original poster and anyone mentioned.
    const parent = (await db.doc(`convs/${cid}/msgs/${threadOf}`).get()).data() || {};
    const inThread = new Set([parent.from, ...(parent.threadUsers || []), ...mentions]);
    recipients = recipients.filter((u) => inThread.has(u));
  }
  if (!recipients.length) return;

  const tokens = await tokensFor(recipients);
  if (!tokens.length) return;

  const where = conv.type === 'channel' ? `#${conv.name}` : conv.type === 'group' ? conv.name : null;
  const sends = tokens.map(({ uid, token }) => {
    const important = conv.type === 'dm' || mentions.includes(uid) || mentions.includes('all');
    const title = conv.type === 'dm' ? name : mentions.includes(uid) ? `${name} mentioned you in ${where}` : where;
    const body = conv.type === 'dm' ? snippet(msg) : `${name}: ${snippet(msg)}`;
    return {
      token,
      notification: { title: threadOf ? `${title} · thread` : title, body },
      data: { cid, mid: threadOf || '', kind: conv.type },
      android: {
        priority: important ? 'high' : 'normal',
        notification: { channelId: important ? 'messages' : 'channels', tag: cid, icon: 'ic_notify', color: '#0B6B4D' },
      },
      webpush: { fcmOptions: { link: `/?c=${encodeURIComponent(cid)}` } },
    };
  });

  const res = await getMessaging().sendEach(sends);
  // Forget tokens of uninstalled apps or signed-out browsers.
  const stale = [];
  res?.responses.forEach((r, i) => {
    const code = r.error?.code || '';
    if (code.includes('registration-token-not-registered') || code.includes('invalid-argument')) stale.push(tokens[i].ref);
  });
  await Promise.all(stale.map((ref) => ref.update({ fcm: null }).catch(() => {})));
}

export const pushMessage = onDocumentCreated('convs/{cid}/msgs/{mid}', (event) =>
  notify(event.params.cid, event.data.data()));

export const pushReply = onDocumentCreated('convs/{cid}/msgs/{mid}/replies/{rid}', (event) =>
  notify(event.params.cid, event.data.data(), { threadOf: event.params.mid }));
