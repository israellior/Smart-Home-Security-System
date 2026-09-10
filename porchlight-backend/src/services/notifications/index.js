import { Membership } from '../../models/Membership.js';
import { PushSubscription } from '../../models/PushSubscription.js';
import { NotificationDelivery } from '../../models/NotificationDelivery.js';
import * as webPush from './channels/webPush.js';
import * as email from './channels/email.js';

const CHANNELS = [webPush, email];

// Which membership preference gates which event type. An event type with
// no entry here notifies nobody, which is the safe default for a type
// added later - it stays silent until someone decides who should hear it.
const PREFERENCE_BY_EVENT_TYPE = {
  motion: 'notifMotion',
  ring: 'notifRing'
};

const COPY_BY_EVENT_TYPE = {
  motion: { title: 'Motion detected', body: (device) => `Movement at ${device.name}` },
  ring: { title: 'Someone rang the bell', body: (device) => `Someone is at ${device.name}` }
};

/**
 * Sends one event to everyone who asked to hear about it.
 *
 * Everyone with access already sees the event in the activity list -
 * that's shared and unfiltered. This is only about pushing it out to a
 * phone or an inbox, which is opt-in per person per doorbell.
 *
 * Query cost is fixed, not proportional to the number of members:
 *   1. memberships for this device with the right preference on
 *   2. push subscriptions for all of those users at once ($in)
 *   3. one insertMany for the delivery log
 * A per-recipient loop issuing its own queries would be the obvious
 * shape and would turn a 3-query dispatch into 2N+1.
 */
export async function dispatchEventNotifications(device, event) {
  const preferenceKey = PREFERENCE_BY_EVENT_TYPE[event.type];
  if (!preferenceKey) return { recipients: 0, deliveries: 0 };

  // Query 1. Served by the leading field of the { device, user } index.
  const memberships = await Membership.find({
    device: device._id,
    [preferenceKey]: true
  }).populate('user', 'name email');

  const withUser = memberships.filter((m) => m.user);
  if (withUser.length === 0) return { recipients: 0, deliveries: 0 };

  // Query 2. One round trip for every recipient's subscriptions, then
  // grouped in memory - not one query per person.
  const userIds = withUser.map((m) => m.user._id);
  const subscriptions = await PushSubscription.find({ user: { $in: userIds } });

  const subscriptionsByUser = new Map();
  for (const sub of subscriptions) {
    const key = String(sub.user);
    if (!subscriptionsByUser.has(key)) subscriptionsByUser.set(key, []);
    subscriptionsByUser.get(key).push(sub);
  }

  const recipients = withUser.map((m) => ({
    user: m.user,
    subscriptions: subscriptionsByUser.get(String(m.user._id)) || []
  }));

  const copy = COPY_BY_EVENT_TYPE[event.type];
  const payload = {
    title: copy.title,
    body: copy.body(device),
    url: `/devices/${device._id}/activity`,
    device,
    event
  };

  // Channels run in parallel - email being slow shouldn't delay push.
  // Each returns one result per recipient rather than throwing, so one
  // failing channel can't stop the others from reporting.
  const settled = await Promise.allSettled(
    CHANNELS.map(async (channel) => ({
      channel: channel.name,
      results: await channel.send(payload, recipients)
    }))
  );

  const rows = [];
  for (const outcome of settled) {
    if (outcome.status === 'rejected') {
      // A channel threw instead of returning results. Record it against
      // every recipient so the log doesn't just go quiet.
      const reason = String(outcome.reason?.message || outcome.reason).slice(0, 300);
      for (const r of recipients) {
        rows.push({
          user: r.user._id,
          device: device._id,
          event: event._id,
          channel: 'unknown',
          status: 'failed',
          reason
        });
      }
      continue;
    }

    for (const result of outcome.value.results) {
      rows.push({
        user: result.userId,
        device: device._id,
        event: event._id,
        channel: outcome.value.channel,
        status: result.status,
        reason: result.reason || ''
      });
    }
  }

  // Query 3. One write for the whole fan-out.
  if (rows.length > 0) await NotificationDelivery.insertMany(rows, { ordered: false });

  return { recipients: recipients.length, deliveries: rows.length };
}
