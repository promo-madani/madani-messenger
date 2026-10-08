// A second test person for the local emulator ("Bilal Raza", Video editor).
// Joins if needed, then: node tests/bot.mjs dm <username> "<text>"   or   node tests/bot.mjs channel <name> "<text>"
// Test accounts used in local testing (emulator only, never real):
//   ali.raza / 246810    bilal.raza / 135790    team code: madani-2026 (see seed.mjs)
import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInWithEmailAndPassword, createUserWithEmailAndPassword } from 'firebase/auth';
import {
  getFirestore, connectFirestoreEmulator, doc, getDoc, setDoc, writeBatch, collection, serverTimestamp, query, where, getDocs, arrayUnion, updateDoc,
} from 'firebase/firestore';

const app = initializeApp({ apiKey: 'demo-key', projectId: 'demo-madani', authDomain: 'demo-madani.firebaseapp.com' });
const auth = getAuth(app);
connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
const db = getFirestore(app);
connectFirestoreEmulator(db, '127.0.0.1', 8085);

const EMAIL = 'bilal.raza@users.madani.invalid';
const PIN = '135790';
let cred;
try {
  cred = await signInWithEmailAndPassword(auth, EMAIL, PIN);
} catch {
  cred = await createUserWithEmailAndPassword(auth, EMAIL, PIN);
  const b = writeBatch(db);
  b.set(doc(db, `users/${cred.user.uid}/private/join`), { code: 'madani-2026' });
  b.set(doc(db, `users/${cred.user.uid}`), { username: 'bilal.raza', displayName: 'Bilal Raza', title: 'Video editor', color: '#2F6FDB', createdAt: serverTimestamp(), lastSeen: serverTimestamp() });
  await b.commit();
  console.log('Bilal joined');
}
const me = cred.user.uid;
await updateDoc(doc(db, `users/${me}`), { lastSeen: serverTimestamp() });

const [, , mode, target, text] = process.argv;
async function send(cid, t) {
  const ref = doc(collection(db, `convs/${cid}/msgs`));
  const b = writeBatch(db);
  b.set(ref, { from: me, ts: serverTimestamp(), kind: 'text', text: t });
  b.update(doc(db, `convs/${cid}`), { last: { text: t, from: me, kind: 'text', ts: serverTimestamp(), id: ref.id }, updatedAt: serverTimestamp() });
  await b.commit();
}
if (mode === 'dm') {
  const other = (await getDocs(query(collection(db, 'users'), where('username', '==', target)))).docs[0];
  const id = `dm_${[me, other.id].sort().join('_')}`;
  if (!(await getDoc(doc(db, `convs/${id}`))).exists()) {
    await setDoc(doc(db, `convs/${id}`), { type: 'dm', members: [me, other.id].sort(), createdBy: me, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
  }
  await send(id, text);
  console.log('sent DM');
} else if (mode === 'channel') {
  const cid = `c_${target}`;
  await updateDoc(doc(db, `convs/${cid}`), { members: arrayUnion(me) });
  await send(cid, text);
  console.log('sent to channel');
}
process.exit(0);
