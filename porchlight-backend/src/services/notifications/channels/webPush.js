/**
 * Web Push channel - the one that reaches a phone.
 *
 * NOT IMPLEMENTED YET, on purpose. Everything around it is: recipients
 * are resolved, preferences are honoured, subscriptions are loaded and
 * handed in, and outcomes are logged. This module is the only thing
 * standing between the current state and real notifications on a phone.
 *
 * To finish it:
 *   1. npm install web-push
 *   2. npx web-push generate-vapid-keys
 *   3. put VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT in .env
 *   4. replace the body of send() with webpush.sendNotification(...)
 *      per subscription, and delete a subscription row on 404/410
 *      (the push service saying it's permanently gone)
 *   5. frontend: register a service worker, subscribe, POST the
 *      subscription to the API
 *
 * No other file needs to change.
 */
export const name = 'webPush';

export function isConfigured() {
  return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

/**
 * @param {object} payload  { title, body, url, device, event }
 * @param {Array}  recipients  [{ user, subscriptions: [PushSubscription] }]
 * @returns {Array} [{ userId, status, reason }] - one per recipient
 */
export async function send(payload, recipients) {
  if (!isConfigured()) {
    return recipients.map((r) => ({
      userId: r.user._id,
      status: 'skipped',
      reason: 'webPush not configured (VAPID keys missing)'
    }));
  }

  // Configured but unimplemented: report honestly rather than silently
  // claiming success, so a delivery log never says "sent" for something
  // that never left the process.
  return recipients.map((r) => {
    if (r.subscriptions.length === 0) {
      return {
        userId: r.user._id,
        status: 'skipped',
        reason: 'no push subscription for this user'
      };
    }
    console.log(
      `[webPush] would send to ${r.user.email} ` +
        `(${r.subscriptions.length} subscription(s)): ${payload.title} - ${payload.body}`
    );
    return {
      userId: r.user._id,
      status: 'skipped',
      reason: 'webPush send() not implemented yet'
    };
  });
}
