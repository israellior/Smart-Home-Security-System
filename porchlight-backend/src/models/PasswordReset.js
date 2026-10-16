import mongoose from 'mongoose';

/**
 * One outstanding "forgot password" link.
 *
 * Only the SHA-256 of the token is stored. The token itself exists in
 * exactly one place, the email, so a database dump hands nobody a way
 * into an account. A plain hash rather than bcrypt because the token is
 * 32 random bytes, not something a person chose - there is no dictionary
 * to slow down.
 *
 * Its own collection rather than two fields on User, so the TTL index can
 * delete expired links by itself: no sweeper, and no stale reset state
 * left on the user document forever.
 */
const passwordResetSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  tokenHash: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true }
});

// Mongo's TTL monitor runs about once a minute, so a link can outlive its
// expiresAt briefly. The reset handler checks expiresAt itself and does
// not rely on this for correctness; this is only cleanup.
passwordResetSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const PasswordReset = mongoose.model('PasswordReset', passwordResetSchema);
