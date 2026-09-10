import mongoose from 'mongoose';

const THIRTY_DAYS_IN_SECONDS = 30 * 24 * 60 * 60;

/**
 * The record of one attempt to push one event to one person on one
 * channel. Deliberately NOT a copy of the notification's content: the
 * Event already holds that, is shared by everyone with access, and is
 * stored exactly once. This row is a pointer plus an outcome.
 *
 * It exists to answer the question people actually ask - "why didn't I
 * get an alert?" - which is otherwise unanswerable. Was the preference
 * off, was there no push subscription, did the push service reject it,
 * or was the channel never configured? Each of those is a different
 * `status`/`reason` here.
 */
const notificationDeliverySchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    device: { type: mongoose.Schema.Types.ObjectId, ref: 'Device', required: true },
    // Absent for notifications that aren't tied to one event, such as
    // the future daily summary.
    event: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', default: null },

    channel: { type: String, required: true }, // 'webPush' | 'email' | ...
    status: {
      type: String,
      enum: ['sent', 'failed', 'skipped'],
      required: true
    },
    // Why it was skipped or how it failed. Empty on success.
    reason: { type: String, default: '' }
  },
  { timestamps: true }
);

// Serves "show me this person's recent delivery attempts", newest first.
notificationDeliverySchema.index({ user: 1, createdAt: -1 });

// This collection grows with (events x members x channels), which is the
// fastest-growing thing in the system and has no long-term value - a
// delivery log from six months ago answers no question anyone will ask.
// Mongo's TTL monitor deletes expired documents automatically, so the
// collection self-prunes with no cron job and no cleanup script.
notificationDeliverySchema.index({ createdAt: 1 }, { expireAfterSeconds: THIRTY_DAYS_IN_SECONDS });

notificationDeliverySchema.set('toJSON', {
  transform(doc, ret) {
    delete ret.__v;
    return ret;
  }
});

export const NotificationDelivery = mongoose.model(
  'NotificationDelivery',
  notificationDeliverySchema
);
