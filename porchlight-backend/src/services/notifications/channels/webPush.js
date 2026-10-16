import webpush from 'web-push';
import { PushSubscription } from '../../../models/PushSubscription.js';

/**
 * Web Push channel - the one that reaches a phone.
 *
 * A browser that allowed notifications hands us a subscription: an
 * endpoint at its vendor's push service (Google's for Chrome and Android,
 * Apple's for Safari and an iPhone's Home Screen app, Mozilla's, or
 * Microsoft's) plus keys to encrypt for it. We sign each message with our
 * VAPID key and POST it there; the vendor wakes the phone, and the
 * service worker (public/sw.js) shows it.
 *
 * Configured by VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY. Without them
 * nothing is sent and every delivery is logged as skipped, so the rest of
 * the app runs exactly as before.
 */
export const name = 'webPush';

const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } = process.env;

// Who to contact about our traffic, which the push services ask for.
// Apple refuses anything but an https: URL or a mailto:, so a localhost
// origin in development reaches Chrome and Firefox but not an iPhone.
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || process.env.CLIENT_ORIGIN;

export function isConfigured() {
  return Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && VAPID_SUBJECT);
}

export function publicKey() {
  return isConfigured() ? VAPID_PUBLIC_KEY : null;
}

if (isConfigured()) webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

/**
 * The push services a subscription may point at, by host suffix.
 *
 * This is what stops the endpoint being a way to make this server send
 * requests wherever a client likes - into the VPC, or at the instance
 * metadata service. The endpoint comes from the browser, which means it
 * comes from whoever is holding the API token; it is only ever trusted
 * once it names one of these.
 */
const PUSH_SERVICE_HOSTS = [
  'fcm.googleapis.com', // Chrome, Edge on Android, Samsung Internet, Opera
  'push.services.mozilla.com', // Firefox
  'push.apple.com', // Safari, and Home Screen apps on iPhone and iPad
  'notify.windows.com' // Edge on Windows
];

export function isPushServiceEndpoint(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.port) return false;
  return PUSH_SERVICE_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
}

// Push services hold a message this long for a phone that is off or out
// of signal. A ring from five minutes ago is still worth knowing about;
// one from an hour ago is not, and would only arrive to confuse.
const TTL_SECONDS = 5 * 60;

// How many requests to the push services are in flight at once. One
// doorbell with a dozen members on two devices each is two dozen; a
// burst across many doorbells should queue here rather than open
// hundreds of sockets at the same moment.
const CONCURRENCY = 32;

function toWebPushSubscription(sub) {
  return { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } };
}

/**
 * Sends one message to one subscription. Never throws: returns
 * { ok, gone, reason } so a fan-out can report every outcome.
 */
export async function sendToSubscription(sub, message, { urgency = 'normal' } = {}) {
  try {
    await webpush.sendNotification(toWebPushSubscription(sub), JSON.stringify(message), {
      TTL: TTL_SECONDS,
      urgency
    });
    return { ok: true, gone: false, reason: '' };
  } catch (err) {
    // 404 and 410 are the push service saying this subscription will
    // never work again - permission revoked, app removed, browser data
    // cleared. Anything else (429, 5xx, a network error) may be passing.
    const gone = err.statusCode === 404 || err.statusCode === 410;
    const reason = `${err.statusCode || 'network'}: ${String(err.body || err.message).slice(0, 200)}`;
    return { ok: false, gone, reason };
  }
}

/**
 * Removes subscriptions the push service has declared dead, and marks
 * the ones that worked. One write each, whatever the fan-out size.
 */
export async function recordOutcomes(delivered, gone) {
  await Promise.all([
    gone.length > 0 ? PushSubscription.deleteMany({ _id: { $in: gone } }) : null,
    delivered.length > 0
      ? PushSubscription.updateMany({ _id: { $in: delivered } }, { $set: { lastUsedAt: new Date() } })
      : null
  ]);
}

/**
 * @param {object} payload  { title, body, url, tag, device, event }
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

  // What the service worker gets. Only what it shows: the device and
  // event documents stay on the server.
  const message = {
    title: payload.title,
    body: payload.body,
    url: payload.url,
    tag: payload.tag,
    timestamp: payload.event?.at ? new Date(payload.event.at).getTime() : Date.now()
  };
  // A ring is someone waiting at the door now: the push services may wake
  // a phone from power saving for it. Motion can wait for the next wake.
  const urgency = payload.event?.type === 'ring' ? 'high' : 'normal';

  const jobs = recipients.flatMap((r) => r.subscriptions.map((sub) => ({ r, sub })));
  const outcomes = new Array(jobs.length);

  for (let i = 0; i < jobs.length; i += CONCURRENCY) {
    const batch = jobs.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(({ sub }) => sendToSubscription(sub, message, { urgency })));
    results.forEach((result, j) => {
      outcomes[i + j] = result;
    });
  }

  const delivered = [];
  const gone = [];
  const byUser = new Map();
  jobs.forEach(({ r, sub }, i) => {
    const outcome = outcomes[i];
    if (outcome.ok) delivered.push(sub._id);
    if (outcome.gone) gone.push(sub._id);
    const key = String(r.user._id);
    if (!byUser.has(key)) byUser.set(key, []);
    byUser.get(key).push(outcome);
  });

  await recordOutcomes(delivered, gone).catch((err) => {
    console.error('[webPush] could not record outcomes:', err.message);
  });

  // One row per person, not per subscription: "did this reach them" is
  // the question the delivery log answers. Sent if any device got it.
  return recipients.map((r) => {
    const results = byUser.get(String(r.user._id)) || [];
    if (results.length === 0) {
      return { userId: r.user._id, status: 'skipped', reason: 'no push subscription for this user' };
    }
    if (results.some((x) => x.ok)) {
      const failed = results.filter((x) => !x.ok).length;
      return {
        userId: r.user._id,
        status: 'sent',
        reason: failed ? `${failed} of ${results.length} subscriptions failed` : ''
      };
    }
    return { userId: r.user._id, status: 'failed', reason: results[0].reason };
  });
}
