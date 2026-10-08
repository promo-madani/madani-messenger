# Madani Messenger

Madani Channel's staff messenger: WhatsApp-style chats and groups, Slack-style department
channels with threads, and QR-code linking so the same account opens on a computer.
It runs on Google Firebase, so it works from anywhere (office Wi-Fi, mobile data, home).

> **Roman Urdu khulasa:** Yeh naya messenger internet par chalta hai (Google Firebase), is liye
> phone aur computer ka ek hi Wi-Fi par hona zaroori nahi. Phone par username + PIN se sign in
> karein; computer par QR code scan karke link karein. Neeche "Go live" wale steps IT ya admin
> ek dafa karega.

## What works now

| Area | Features |
|---|---|
| Sign in | Username + PIN (6+ digits). New people join with the **team code**. |
| Chats | Private chats, groups, notes to self, ✓/✓✓ seen ticks, typing…, online / last seen, reply to a message, edit, delete for everyone, emoji reactions, @mentions, Urdu shown right-to-left |
| Channels | Open department channels, join/leave, threads, pinned note, read-only announcement channels (admins only) |
| Files | Photos (shown inline), videos, documents up to 200 MB, voice notes (tap the mic) |
| Devices | **Link a computer with a QR code** (WhatsApp Web style), list of signed-in devices, sign out any device remotely |
| Layout | Phone: one screen with tabs at the bottom. Computer: rail + list + chat + thread side panel. Light and dark mode. |
| Notifications | Sound and browser notifications while the app is open. Push notifications when closed: code is written (`functions/`), switched on at go-live. |
| Not yet | Voice/video calls, message search, Android app package, prayer-time quiet hours |

## Try it on this computer (local test, no internet account needed)

Needs Node.js 20+ and Java 21 (a portable copy is in `D:\android-toolchain\jdk21`).

```bash
npm install
cd functions && npm install && cd ..
npx firebase emulators:start --project demo-madani
node tests/seed.mjs
```

Open <http://127.0.0.1:5050>, choose **Join**, team code `madani-2026`. `tests/bot.mjs` adds a second test
person ("Bilal Raza") who can send you messages. Everything is stored only on this computer and wiped
when the emulators stop.

Tests: `npx firebase emulators:exec --only firestore --project demo-madani "node tests/rules.test.mjs"`
checks the 44 security rules (who can read and write what).

## Go live (one time, about 30 minutes)

1. **Create the Firebase project.** Go to <https://console.firebase.google.com>, sign in with Madani Channel's
   Google account, **Add project** (e.g. `madani-messenger`). Google Analytics is not needed.
2. **Upgrade to the Blaze plan** (Project settings → Usage and billing). It needs a payment card. Files,
   voice notes, push notifications and QR linking need it. For an office team the free monthly
   allowance usually covers everything; set a **budget alert** (e.g. $10) so there are no surprises.
3. **Turn on the services:**
   - Authentication → Sign-in method → enable **Email/Password** and **Anonymous**.
   - Firestore Database → Create database → location **asia-south1 (Mumbai)**, production mode.
   - Storage → Get started → same location.
4. **Add a web app:** Project settings → Your apps → Web (`</>`). Copy the `firebaseConfig` values into
   `public/js/config.js`.
5. **Set the team code and admins:** Firestore → Start collection `config` →
   document `join` with field `code` (string, e.g. `madani-1448`) and document `admins` with field
   `uids` (array). Add admins' user IDs (Authentication tab) after they join.
6. **Allow QR sign-in tokens:** Google Cloud console → IAM → find the
   `<project-id>@appspot.gserviceaccount.com` account → add role **Service Account Token Creator**.
7. **Deploy:** `npx firebase login`, `npx firebase use --add` (pick the project), then `npx firebase deploy`.
   The app is then at `https://<project-id>.web.app`. A custom address such as
   `messenger.madanichannel.tv` can be added under Hosting → Add custom domain.
8. Share the address and the team code with staff.

## How it is built

- `public/` — the app (plain JavaScript modules, no build step), served by Firebase Hosting.
  `js/data.js` holds every read and write; `js/app.js` the screens; `css/app.css` the design.
- `firestore.rules`, `storage.rules` — who can read and write what. Private chats and their files are
  only visible to their members; the team code is never readable by apps; people can only edit
  their own messages, reactions and devices.
- `functions/` — `approveLink` (QR linking: issues a one-time sign-in token that only the waiting
  computer can read) and `pushMessage` / `pushReply` (notifications).
- QR linking: the computer signs in anonymously and publishes a link with a hashed one-time code; the
  QR holds the code. A signed-in phone sees which device is asking, confirms, and the function writes
  the token. Each code lasts one minute. Removing a device from **Linked devices** signs it out.
