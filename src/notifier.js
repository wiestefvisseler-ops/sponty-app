'use strict';

/* ------------------------------------------------------------------ *
 *  notifier.js — where a real push notification goes out.
 *
 *  The app talks to a `send(user, payload)` interface, so you can swap the
 *  dev console logger for Expo / APNs / FCM without touching any logic.
 * ------------------------------------------------------------------ */

class ConsoleNotifier {
  async send(user, { title, body }) {
    const tag = user.pushToken ? `token=${user.pushToken}` : 'no push token';
    console.log(`  🔔  -> ${user.name} (${tag})\n        ${title} — ${body}`);
  }
}

/**
 * Expo push skeleton. Wiring this up is one `fetch` once you have real
 * device tokens from the mobile app (see README -> "Add real push").
 * Left as a no-network stub so this repo runs with zero dependencies.
 */
class ExpoNotifier {
  async send(user, { title, body, data }) {
    if (!user.pushToken) return;
    // Production:
    // await fetch('https://exp.host/--/api/v2/push/send', {
    //   method: 'POST',
    //   headers: { 'Content-Type': 'application/json' },
    //   body: JSON.stringify({ to: user.pushToken, title, body, data }),
    // });
    console.log(`  [expo stub] would push to ${user.pushToken}: ${title}`);
  }
}

module.exports = { ConsoleNotifier, ExpoNotifier };
