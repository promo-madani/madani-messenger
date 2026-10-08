// Firebase setup shared by the whole app.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getAuth, connectAuthEmulator } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  initializeFirestore, connectFirestoreEmulator, persistentLocalCache, persistentMultipleTabManager,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { getStorage, connectStorageEmulator } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-storage.js';
import { getFunctions, connectFunctionsEmulator } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-functions.js';
import { firebaseConfig, REGION } from './config.js';

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
// Keep recent chats on the device so the app opens instantly and works on a weak connection.
export const db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
export const storage = getStorage(app);
export const functions = getFunctions(app, REGION);

export const usingEmulators = firebaseConfig.projectId.startsWith('demo-');
if (usingEmulators) {
  const host = location.hostname || '127.0.0.1';
  connectAuthEmulator(auth, `http://${host}:9099`, { disableWarnings: true });
  connectFirestoreEmulator(db, host, 8085);
  connectStorageEmulator(storage, host, 9199);
  connectFunctionsEmulator(functions, host, 5001);
}
