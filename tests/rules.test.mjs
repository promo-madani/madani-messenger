// Security rules tests. Run: npx firebase emulators:exec --only firestore --project demo-madani "node tests/rules.test.mjs"
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import {
  doc, getDoc, setDoc, updateDoc, writeBatch, collection, serverTimestamp, increment, arrayUnion, deleteField,
  query, where, getDocs, Timestamp,
} from 'firebase/firestore';

const env = await initializeTestEnvironment({
  projectId: 'demo-madani',
  firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8085 },
});

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log('ok  ', name); } catch (e) { failed++; console.error('FAIL', name, '\n     ', e.message); }
}
const EMAIL = (u) => `${u}@users.madani.invalid`;
const as = (uid, username) => env.authenticatedContext(uid, username ? { email: EMAIL(username) } : {}).firestore();

// Seed: join code, an admin, two members, one outsider with no profile.
await env.withSecurityRulesDisabled(async (ctx) => {
  const d = ctx.firestore();
  await setDoc(doc(d, 'config/join'), { code: 'madani-2026' });
  await setDoc(doc(d, 'config/admins'), { uids: ['admin'] });
  for (const [uid, username] of [['admin', 'faizan'], ['ali', 'ali'], ['bilal', 'bilal']]) {
    await setDoc(doc(d, `users/${uid}`), { username, displayName: username, createdAt: Timestamp.now() });
  }
  await setDoc(doc(d, 'convs/promo'), { type: 'channel', name: 'promo', members: ['admin'], createdBy: 'admin', createdAt: Timestamp.now() });
  await setDoc(doc(d, 'convs/news'), { type: 'channel', name: 'announcements', readOnly: true, members: [], createdBy: 'admin', createdAt: Timestamp.now() });
  await setDoc(doc(d, 'convs/grp'), { type: 'group', name: 'Promo Team', members: ['admin', 'ali'], createdBy: 'admin', createdAt: Timestamp.now() });
  await setDoc(doc(d, 'convs/promo/msgs/m1'), { from: 'admin', ts: Timestamp.now(), kind: 'text', text: 'hello' });
  await setDoc(doc(d, 'links/L1234567890'), { pc: 'anonPC', codeHash: 'x', device: 'Chrome on Windows', status: 'pending', createdAt: Timestamp.now() });
  await setDoc(doc(d, 'links/L0000000000'), { pc: 'anonPC', codeHash: 'x', device: 'Chrome on Windows', status: 'approved', token: 'secret', createdAt: Timestamp.now() });
});

// ---------- Joining ----------
const joinBatch = (d, uid, username, code) => {
  const b = writeBatch(d);
  b.set(doc(d, `users/${uid}/private/join`), { code });
  b.set(doc(d, `users/${uid}`), { username, displayName: 'Sara Khan', title: 'Editor', createdAt: serverTimestamp(), lastSeen: serverTimestamp() });
  return b.commit();
};
await check('join with the right team code', () => assertSucceeds(joinBatch(as('sara', 'sara.khan'), 'sara', 'sara.khan', 'madani-2026')));
await check('join with a wrong team code fails', () => assertFails(joinBatch(as('eve', 'eve'), 'eve', 'eve', 'guess')));
await check('cannot claim someone else\'s username', () => assertFails(joinBatch(as('mallory', 'mallory'), 'mallory', 'ali', 'madani-2026')));
await check('the join code cannot be read', () => assertFails(getDoc(doc(as('ali', 'ali'), 'config/join'))));
await check('cannot make yourself admin', () => assertFails(updateDoc(doc(as('ali', 'ali'), 'users/ali'), { role: 'admin' })));
await check('can edit own name', () => assertSucceeds(updateDoc(doc(as('ali', 'ali'), 'users/ali'), { displayName: 'Muhammad Ali' })));
await check('outsiders cannot read people', () => assertFails(getDoc(doc(as('eve', 'eve'), 'users/ali'))));
await check('anonymous computer cannot read people', () => assertFails(getDoc(doc(as('anonPC'), 'users/ali'))));

// ---------- Conversations ----------
await check('members read channels', () => assertSucceeds(getDoc(doc(as('bilal', 'bilal'), 'convs/promo'))));
await check('non-members cannot read a group', () => assertFails(getDoc(doc(as('bilal', 'bilal'), 'convs/grp'))));
await check('group members read the group', () => assertSucceeds(getDoc(doc(as('ali', 'ali'), 'convs/grp'))));
await check('create a DM', () => assertSucceeds(setDoc(doc(as('ali', 'ali'), 'convs/dm_ali_bilal'), {
  type: 'dm', members: ['ali', 'bilal'], createdBy: 'ali', createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
})));
await check('DM id must match its members', () => assertFails(setDoc(doc(as('ali', 'ali'), 'convs/dm_ali_sara'), {
  type: 'dm', members: ['ali', 'bilal'], createdBy: 'ali', createdAt: serverTimestamp(),
})));
await check('cannot snoop on a DM you are not in', () => assertFails(getDoc(doc(as('sara', 'sara.khan'), 'convs/dm_ali_bilal'))));
await check('my chats query works', () => assertSucceeds(getDocs(query(collection(as('ali', 'ali'), 'convs'), where('members', 'array-contains', 'ali')))));
await check('channel list query works', () => assertSucceeds(getDocs(query(collection(as('ali', 'ali'), 'convs'), where('type', '==', 'channel')))));
await check('members create channels', () => assertSucceeds(setDoc(doc(as('ali', 'ali'), 'convs/c_editing'), {
  type: 'channel', name: 'editing', topic: '', members: ['ali'], createdBy: 'ali', createdAt: serverTimestamp(),
})));
await check('only admins create read-only channels', () => assertFails(setDoc(doc(as('ali', 'ali'), 'convs/c_ro'), {
  type: 'channel', name: 'notices', readOnly: true, members: ['ali'], createdBy: 'ali', createdAt: serverTimestamp(),
})));
await check('join a channel', () => assertSucceeds(updateDoc(doc(as('bilal', 'bilal'), 'convs/promo'), { members: arrayUnion('bilal') })));
await check('cannot add others to a channel', () => assertFails(updateDoc(doc(as('bilal', 'bilal'), 'convs/promo'), { members: arrayUnion('sara') })));

// ---------- Messages ----------
const send = (d, cid, id, extra = {}) => {
  const b = writeBatch(d);
  b.set(doc(d, `convs/${cid}/msgs/${id}`), { from: extra.from || d._uid, ts: serverTimestamp(), kind: 'text', text: 'Assalam-o-Alaikum', ...extra.msg });
  b.update(doc(d, `convs/${cid}`), { last: { text: 'Assalam-o-Alaikum', from: extra.from || d._uid }, updatedAt: serverTimestamp() });
  return b.commit();
};
const ali = as('ali', 'ali'); ali._uid = 'ali';
const bilal = as('bilal', 'bilal'); bilal._uid = 'bilal';
const admin = as('admin', 'faizan'); admin._uid = 'admin';
await check('send in a DM', () => assertSucceeds(send(ali, 'dm_ali_bilal', 'a1')));
await check('cannot send as someone else', () => assertFails(send(ali, 'dm_ali_bilal', 'a2', { from: 'bilal' })));
await check('send in a channel', () => assertSucceeds(send(bilal, 'promo', 'b1')));
await check('members cannot post in read-only channel', () => assertFails(send(bilal, 'news', 'b2')));
await check('admins post in read-only channel', () => assertSucceeds(send(admin, 'news', 'n1')));
await check('cannot post in a group you are not in', () => assertFails(send(bilal, 'grp', 'b3')));
await check('react to a message', () => assertSucceeds(updateDoc(doc(bilal, 'convs/promo/msgs/m1'), { 'reactions.bilal': '👍' })));
await check('cannot change others\' reactions', () => assertFails(updateDoc(doc(ali, 'convs/promo/msgs/m1'), { 'reactions.bilal': deleteField() })));
await check('remove own reaction', () => assertSucceeds(updateDoc(doc(bilal, 'convs/promo/msgs/m1'), { 'reactions.bilal': deleteField() })));
await check('cannot edit someone else\'s message', () => assertFails(updateDoc(doc(bilal, 'convs/promo/msgs/m1'), { text: 'hacked', edited: serverTimestamp() })));
await check('delete own message for everyone', () => assertSucceeds(updateDoc(doc(bilal, 'convs/promo/msgs/b1'), { deleted: true, text: '', file: null })));
await check('thread reply + counter', async () => {
  const b = writeBatch(ali);
  b.set(doc(ali, 'convs/promo/msgs/m1/replies/r1'), { from: 'ali', ts: serverTimestamp(), kind: 'text', text: 'JazakAllah' });
  b.update(doc(ali, 'convs/promo/msgs/m1'), { threadCount: increment(1), threadLast: serverTimestamp(), threadUsers: arrayUnion('ali') });
  await assertSucceeds(b.commit());
});
await check('thread counter cannot jump', () => assertFails(updateDoc(doc(ali, 'convs/promo/msgs/m1'), { threadCount: 50, threadLast: serverTimestamp(), threadUsers: [] })));
await check('read receipt', () => assertSucceeds(setDoc(doc(ali, 'convs/dm_ali_bilal/reads/ali'), { ts: serverTimestamp() })));
await check('cannot fake someone\'s read receipt', () => assertFails(setDoc(doc(ali, 'convs/dm_ali_bilal/reads/bilal'), { ts: serverTimestamp() })));

// ---------- QR links ----------
const pc = as('anonPC');
await check('computer creates a link', () => assertSucceeds(setDoc(doc(pc, 'links/Lnew0000001'), {
  pc: 'anonPC', codeHash: 'abc', device: 'Edge on Windows', status: 'pending', createdAt: serverTimestamp(),
})));
await check('computer cannot pre-approve its own link', () => assertFails(setDoc(doc(pc, 'links/Lnew0000002'), {
  pc: 'anonPC', codeHash: 'abc', device: 'Edge', status: 'approved', createdAt: serverTimestamp(),
})));
await check('phone peeks at a pending link', () => assertSucceeds(getDoc(doc(ali, 'links/L1234567890'))));
await check('nobody else reads an approved link (token)', () => assertFails(getDoc(doc(ali, 'links/L0000000000'))));
await check('the computer reads its approved link', () => assertSucceeds(getDoc(doc(pc, 'links/L0000000000'))));
await check('apps cannot approve links directly', () => assertFails(updateDoc(doc(ali, 'links/L1234567890'), { status: 'approved', token: 'x' })));
await check('links cannot be listed', () => assertFails(getDocs(collection(ali, 'links'))));

// ---------- Devices ----------
await check('register my device', () => assertSucceeds(setDoc(doc(ali, 'users/ali/devices/d1'), { name: 'Chrome on Windows', platform: 'web', via: 'qr', createdAt: serverTimestamp(), lastActive: serverTimestamp() })));
await check('cannot see others\' devices', () => assertFails(getDoc(doc(bilal, 'users/ali/devices/d1'))));

await env.cleanup();
console.log(failed ? `\n${failed} FAILED` : '\nALL RULES TESTS PASSED');
process.exit(failed ? 1 : 0);
