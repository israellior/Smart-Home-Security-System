import { api } from '../api/client';

/**
 * Everything about Web Push that isn't React: what this browser can do,
 * the service worker, and the subscription itself. usePushNotifications
 * is the React side.
 *
 * A subscription belongs to this browser, not to a doorbell. Which
 * doorbells and which kinds of event reach it is decided on the server
 * from each membership's toggles; this only decides whether this phone
 * or computer is somewhere alerts can go at all.
 */

const SW_URL = '/sw.js';

export function isIos() {
  const ua = navigator.userAgent;
  // iPadOS reports itself as a Mac; touch is what gives it away.
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function isStandalone() {
  return window.navigator.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches;
}

/**
 * 'supported'      can subscribe here
 * 'install-first'  an iPhone or iPad in Safari: Apple only allows web
 *                  notifications for an app added to the Home Screen
 * 'unsupported'    this browser has no Web Push at all
 */
export function pushSupport() {
  const hasApis = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (hasApis) return 'supported';
  if (isIos() && !isStandalone()) return 'install-first';
  return 'unsupported';
}

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return Promise.resolve(null);
  return navigator.serviceWorker.register(SW_URL).catch((err) => {
    console.warn('Service worker registration failed:', err.message);
    return null;
  });
}

async function currentSubscription() {
  if (pushSupport() !== 'supported') return null;
  const registration = await navigator.serviceWorker.getRegistration(SW_URL);
  return registration ? registration.pushManager.getSubscription() : null;
}

// The VAPID key arrives base64url-encoded; subscribe() wants the bytes.
function keyBytes(base64url) {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

/**
 * Asks permission (must be called from a tap - Safari refuses otherwise),
 * subscribes, and tells the server. Returns the subscription's endpoint.
 */
export async function subscribe(token) {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    const err = new Error(
      permission === 'denied'
        ? 'Notifications are blocked for Porchlight in this browser.'
        : 'Notifications were not allowed.'
    );
    err.permission = permission;
    throw err;
  }

  const registration = (await registerServiceWorker()) || (await navigator.serviceWorker.ready);
  const { publicKey } = await api.getPushKey();

  let subscription = await registration.pushManager.getSubscription();
  // A subscription made with a different key (the server's keys were
  // replaced) can never receive anything from us. Start again.
  if (subscription) {
    const existingKey = subscription.options?.applicationServerKey;
    const wanted = keyBytes(publicKey);
    const same =
      existingKey &&
      new Uint8Array(existingKey).length === wanted.length &&
      new Uint8Array(existingKey).every((b, i) => b === wanted[i]);
    if (!same) {
      await subscription.unsubscribe();
      subscription = null;
    }
  }
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes(publicKey)
    });
  }

  await api.savePushSubscription(token, subscription.toJSON());
  return subscription.endpoint;
}

/** Stops alerts reaching this browser, here and on the server. */
export async function unsubscribe(token) {
  const subscription = await currentSubscription();
  if (!subscription) return;
  const { endpoint } = subscription;
  await subscription.unsubscribe();
  if (token) await api.deletePushSubscription(token, endpoint).catch(() => {});
}

/**
 * What this browser is set to right now: { permission, endpoint }.
 * endpoint is null when it isn't subscribed.
 */
export async function pushState() {
  if (pushSupport() !== 'supported') return { permission: 'default', endpoint: null };
  const subscription = await currentSubscription().catch(() => null);
  return { permission: Notification.permission, endpoint: subscription?.endpoint || null };
}

/**
 * Sent each time the app opens signed in. Browsers renew subscriptions
 * on their own schedule, and a renewed one the server doesn't know about
 * is a phone that silently stops getting alerts. Re-sending is an upsert
 * keyed on the endpoint, so it costs nothing when nothing changed.
 */
export async function syncSubscription(token) {
  if (pushSupport() !== 'supported' || Notification.permission !== 'granted') return;
  const subscription = await currentSubscription().catch(() => null);
  if (subscription) await api.savePushSubscription(token, subscription.toJSON()).catch(() => {});
}
