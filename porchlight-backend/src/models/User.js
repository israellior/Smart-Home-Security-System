import mongoose from 'mongoose';

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true }
  },
  { timestamps: true }
);

/**
 * Structural guarantee that a password hash can never reach a response,
 * whatever route sends it. authController's publicUser() still shapes the
 * auth responses deliberately, but this is the backstop for every other
 * path - notably .populate('user'), which the device members list uses:
 * without this, populating a User would hand the whole document,
 * passwordHash included, straight to res.json().
 */
userSchema.set('toJSON', {
  transform(doc, ret) {
    delete ret.passwordHash;
    delete ret.__v;
    return ret;
  }
});

export const User = mongoose.model('User', userSchema);
