import mongoose from 'mongoose';

/**
 * One Web Push subscription - a specific browser on a specific device
 * that has granted permission to receive notifications. A person with a
 * phone and a laptop has two of these; revoking permission in one
 * browser leaves the other working.
 *
 * The shape mirrors the browser's PushSubscription object exactly
 * (endpoint + p256dh/auth keys), because that's what the push service
 * requires to encrypt and route a message. Nothing sends these yet -
 * the model exists so the subscribe flow can be built and stored ahead
 * of the delivery code, and so channels/webPush.js has something real
 * to read once VAPID keys are configured.
 */
const pushSubscriptionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    // The push service URL the browser gave us. Unique because
    // re-subscribing in the same browser returns the same endpoint -
    // this is what stops duplicate rows accumulating over time.
    endpoint: { type: String, required: true, unique: true },

    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true }
    },

    // Purely so a future "your devices" screen can say "Chrome on
    // Windows" rather than showing a 200-character endpoint URL.
    userAgent: { type: String, default: '' },

    // Push services expire subscriptions. When one returns 404/410 we
    // delete the row; this timestamp helps prune ones that simply went
    // quiet without ever erroring.
    lastUsedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

pushSubscriptionSchema.set('toJSON', {
  transform(doc, ret) {
    delete ret.__v;
    // The keys are cryptographic material for the push service, not
    // something any client needs back.
    delete ret.keys;
    return ret;
  }
});

export const PushSubscription = mongoose.model('PushSubscription', pushSubscriptionSchema);
