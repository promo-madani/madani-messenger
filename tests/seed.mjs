// Seeds the local emulator with the team join code and starter channels.
// Run while the emulators are up: node tests/seed.mjs
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, setDoc, Timestamp } from 'firebase/firestore';

const env = await initializeTestEnvironment({ projectId: 'demo-madani', firestore: { host: '127.0.0.1', port: 8085 } });
await env.withSecurityRulesDisabled(async (ctx) => {
  const d = ctx.firestore();
  await setDoc(doc(d, 'config/join'), { code: 'madani-2026' });
  await setDoc(doc(d, 'config/admins'), { uids: [] });
  const now = Timestamp.now();
  const channels = [
    ['announcements', 'Official notices from management', true],
    ['general', 'Everyone at Madani Channel', false],
    ['promo', 'Promos, trailers and on-air graphics', false],
    ['it-help', 'Ask IT anything', false],
  ];
  for (const [name, topic, readOnly] of channels) {
    await setDoc(doc(d, `convs/c_${name}`), { type: 'channel', name, topic, readOnly, members: [], createdBy: 'system', createdAt: now, updatedAt: now });
  }
});
await env.cleanup();
console.log('Seeded: team code "madani-2026" and 4 channels.');
