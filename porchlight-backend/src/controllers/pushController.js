import { PushSubscription } from '../models/PushSubscription.js';
import {
  publicKey,
  isPushServiceEndpoint,
  sendToSubscription,
  recordOutcomes
} from '../services/notifications/channels/webPush.js';
import { consume } from '../utils/rateLimit.js';

// A person's phones, laptops and browsers. Generous for one person, and a
// ceiling on what one token can make this collection hold.
const MAX_SUBSCRIPTIONS_PER_USER = 20;

const TEST_LIMIT_PER_USER = { limit: 5, windowMs: 10 * 60 * 1000 };

function validSubscription(body) {
  const { endpoint, keys } = body || {};
  return (
    typeof endpoint === 'string' &&
    endpoint.length <= 1000 &&
    isPushServiceEndpoint(endpoint) &&
    typeof keys?.p256dh === 'string' &&
    typeof keys?.auth === 'string' &&
    keys.p256dh.length <= 200 &&
    keys.auth.length <= 100
  );
}

/** The key a browser subscribes with. Public by design; no login needed. */
export function getPublicKey(req, res) {
  const key = publicKey();
  if (!key) return res.status(503).json({ error: 'Notifications are not set up on this server' });
  return res.json({ publicKey: key });
}

/**
 * Saves this browser's subscription for the signed-in user. PUT, and
 * keyed on the endpoint, because the app sends it again every time it
 * opens: a subscription the browser quietly renewed replaces the old row,
 * and one that moved to a different account on a shared browser moves
 * with it rather than alerting both.
 */
export async function saveSubscription(req, res) {
  if (!validSubscription(req.body)) {
    return res.status(400).json({ error: 'That is not a push subscription this server can use' });
  }
  const { endpoint, keys } = req.body;

  await PushSubscription.updateOne(
    { endpoint },
    {
      $set: {
        user: req.userId,
        keys: { p256dh: keys.p256dh, auth: keys.auth },
        userAgent: String(req.get('user-agent') || '').slice(0, 300)
      }
    },
    { upsert: true }
  );

  // Oldest out past the ceiling. Cheap: served by the user index, and
  // almost always finds nothing to delete.
  const extra = await PushSubscription.find({ user: req.userId }, { _id: 1 })
    .sort({ updatedAt: -1 })
    .skip(MAX_SUBSCRIPTIONS_PER_USER)
    .lean();
  if (extra.length > 0) await PushSubscription.deleteMany({ _id: { $in: extra.map((s) => s._id) } });

  return res.status(204).end();
}

/** This browser stops getting alerts: turned off, or signing out. */
export async function deleteSubscription(req, res) {
  const { endpoint } = req.body || {};
  if (typeof endpoint !== 'string') return res.status(400).json({ error: 'endpoint is required' });
  await PushSubscription.deleteOne({ endpoint, user: req.userId });
  return res.status(204).end();
}

/**
 * "Send a test" - to this browser only, so the person pressing it learns
 * whether *this* device works, not whether some other one of theirs does.
 */
export async function sendTest(req, res) {
  const { endpoint } = req.body || {};
  if (typeof endpoint !== 'string') return res.status(400).json({ error: 'endpoint is required' });

  const limit = consume('push-test:user', req.userId, TEST_LIMIT_PER_USER);
  if (!limit.allowed) {
    res.set('Retry-After', String(Math.ceil(limit.retryAfterMs / 1000)));
    return res.status(429).json({ error: 'Too many tests. Try again in a few minutes.' });
  }

  const sub = await PushSubscription.findOne({ endpoint, user: req.userId });
  if (!sub) return res.status(404).json({ error: 'Notifications are not on for this device' });

  const outcome = await sendToSubscription(
    sub,
    {
      title: 'Notifications are on',
      body: "This is how you'll know someone is at your door.",
      url: '/',
      tag: 'test',
      timestamp: Date.now()
    },
    { urgency: 'high' }
  );
  await recordOutcomes(outcome.ok ? [sub._id] : [], outcome.gone ? [sub._id] : []);

  if (outcome.gone) {
    return res.status(410).json({ error: 'This device stopped accepting notifications. Turn them on again.' });
  }
  if (!outcome.ok) {
    console.error('[webPush] test failed:', outcome.reason);
    return res.status(502).json({ error: "The notification service didn't accept it. Try again in a moment." });
  }
  return res.status(204).end();
}
