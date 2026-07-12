'use strict';

const webpush = require('web-push');

// VAPID keys are generated once at startup. Set VAPID_PUBLIC_KEY and
// VAPID_PRIVATE_KEY as env vars in Railway to make them persist across deploys.
let vapidPublic, vapidPrivate;

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  vapidPublic  = process.env.VAPID_PUBLIC_KEY;
  vapidPrivate = process.env.VAPID_PRIVATE_KEY;
} else {
  const keys = webpush.generateVAPIDKeys();
  vapidPublic  = keys.publicKey;
  vapidPrivate = keys.privateKey;
  console.log('\n  ⚠️  No VAPID keys set — generated temporary ones.');
  console.log('     Push subscriptions will break on next redeploy.');
  console.log('     Set these in Railway environment variables to fix it:');
  console.log(`     VAPID_PUBLIC_KEY=${vapidPublic}`);
  console.log(`     VAPID_PRIVATE_KEY=${vapidPrivate}\n`);
}

webpush.setVapidDetails('mailto:sponty@example.com', vapidPublic, vapidPrivate);

// Exported so the server can give it to clients
const PUBLIC_VAPID_KEY = vapidPublic;

class WebPushNotifier {
  async send(user, { title, body }) {
    console.log(`  🔔 push to ${user.name} — sub: ${user.pushSubscription ? 'yes' : 'NO'}`);
    if (!user.pushSubscription) return;
    try {
      await webpush.sendNotification(
        user.pushSubscription,
        JSON.stringify({ title, body })
      );
      console.log(`  ✅ push sent to ${user.name}`);
    } catch (e) {
      console.log(`  ❌ push failed for ${user.name}: ${e.statusCode} ${e.message}`);
      if (e.statusCode === 410 || e.statusCode === 404) {
        user.pushSubscription = null;
      }
    }
  }
}

class ConsoleNotifier {
  async send(user, { title, body }) {
    console.log(`  🔔  -> ${user.name}\n        ${title} — ${body}`);
  }
}

module.exports = { WebPushNotifier, ConsoleNotifier, PUBLIC_VAPID_KEY };
