// Firebase project settings. For local testing this points at the Firebase emulators
// (any projectId starting with "demo-"). For the real app, replace these values with the
// ones from Firebase console → Project settings → Your apps → Web app → SDK setup.
export const firebaseConfig = {
  apiKey: 'demo-key',
  authDomain: 'demo-madani.firebaseapp.com',
  projectId: 'demo-madani',
  storageBucket: 'demo-madani.appspot.com',
  messagingSenderId: '000000000000',
  appId: '1:000000000000:web:0000000000000000',
};

// Web push key: Firebase console → Project settings → Cloud Messaging → Web Push certificates.
// Leave empty to turn off notifications in browsers when the tab is closed.
export const vapidKey = '';

export const REGION = 'asia-south1';
export const APP_NAME = 'Madani Messenger';
// Usernames become sign-in emails on this reserved (never-delivered) domain.
export const EMAIL_DOMAIN = 'users.madani.invalid';
