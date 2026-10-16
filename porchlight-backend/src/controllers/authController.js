import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { User } from '../models/User.js';
import { PasswordReset } from '../models/PasswordReset.js';
import { PushSubscription } from '../models/PushSubscription.js';
import { Membership } from '../models/Membership.js';
import { purgeDevice } from '../services/devices.js';
import { sendPasswordResetEmail, sendPasswordChangedEmail } from '../services/accountEmails.js';
import { consume, peek, forget } from '../utils/rateLimit.js';
import { disconnectUser } from '../signaling/index.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// 254 is the longest address SMTP can deliver to. The name cap is
// generous; it only exists so a request cannot store a megabyte of it.
const MAX_EMAIL = 254;
const MAX_NAME = 100;

// Only failures are charged, so someone who fumbles their password and
// then gets it right pays nothing toward the per-email bucket.
//
// Two buckets because each one alone has a hole. Per email stops a
// botnet spreading guesses at one account over thousands of addresses;
// per IP stops one machine walking a list of accounts. The cost of the
// per-email bucket is deliberate and worth naming: anyone who knows your
// email can lock it out for fifteen minutes by typing wrong passwords.
// Fifteen minutes of nuisance is the right trade against an account that
// can be guessed at forever.
const LOGIN_LIMIT_PER_EMAIL = { limit: 10, windowMs: 15 * 60 * 1000 };
const LOGIN_LIMIT_PER_IP = { limit: 30, windowMs: 15 * 60 * 1000 };

// Every attempt counts here, success included, because a success is
// itself the thing being limited: a new account, and a bcrypt hash.
const REGISTER_LIMIT_PER_IP = { limit: 10, windowMs: 60 * 60 * 1000 };

// Every request counts, whether or not the address has an account - the
// limit has to behave the same either way or it becomes a way to find
// out. Per email is what stops this being used to fill someone's inbox;
// per IP is what stops one machine doing it to a list of people.
const FORGOT_LIMIT_PER_EMAIL = { limit: 3, windowMs: 60 * 60 * 1000 };
const FORGOT_LIMIT_PER_IP = { limit: 10, windowMs: 60 * 60 * 1000 };

const RESET_TTL_MINUTES = 60;

function hashResetToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function signToken(user) {
  // "sub" (subject) is the standard JWT claim for "who is this token
  // about". "ver" is the user's tokenVersion at issue - see
  // verifyUserToken for what makes it worth carrying.
  return jwt.sign({ sub: user._id.toString(), ver: user.tokenVersion ?? 0 }, process.env.JWT_SECRET, {
    expiresIn: '7d'
  });
}

function publicUser(user) {
  return { id: user._id, name: user.name, email: user.email };
}

function tooMany(res, retryAfterMs) {
  res.set('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
  return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
}

export async function register(req, res) {
  const { name, email, password } = req.body || {};

  // Strings, checked as such. Without this an object or an array reaches
  // .length and .toLowerCase() below, and a malformed request becomes a
  // 500 that says the server is broken.
  if (typeof name !== 'string' || typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'name, email and password are all required' });
  }
  if (!name.trim() || !email || !password) {
    return res.status(400).json({ error: 'name, email and password are all required' });
  }
  if (name.length > MAX_NAME) {
    return res.status(400).json({ error: `Name must be at most ${MAX_NAME} characters` });
  }
  if (email.length > MAX_EMAIL || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'That email address doesn\'t look valid' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  // After the format checks, so a typo does not spend an attempt.
  const perIp = consume('register:ip', req.ip, REGISTER_LIMIT_PER_IP);
  if (!perIp.allowed) return tooMany(res, perIp.retryAfterMs);

  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) {
    return res.status(409).json({ error: 'An account with that email already exists' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await User.create({ name, email, passwordHash });

  const token = signToken(user);
  return res.status(201).json({ token, user: publicUser(user) });
}

export async function login(req, res) {
  const { email, password } = req.body || {};

  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  const emailKey = email.trim().toLowerCase();

  // Checked before the bcrypt compare, not after: refusing once the hash
  // has run would still hand a guesser the CPU.
  const perEmail = peek('login:email', emailKey, LOGIN_LIMIT_PER_EMAIL);
  const perIp = peek('login:ip', req.ip, LOGIN_LIMIT_PER_IP);
  if (!perEmail.allowed || !perIp.allowed) {
    return tooMany(res, Math.max(perEmail.retryAfterMs, perIp.retryAfterMs));
  }

  const failed = () => {
    consume('login:email', emailKey, LOGIN_LIMIT_PER_EMAIL);
    consume('login:ip', req.ip, LOGIN_LIMIT_PER_IP);
    // Deliberately the same error for "no such user" and "wrong password" -
    // being specific here would let an attacker enumerate valid emails.
    return res.status(401).json({ error: 'Incorrect email or password' });
  };

  const user = await User.findOne({ email: emailKey });
  if (!user) return failed();

  const matches = await bcrypt.compare(password, user.passwordHash);
  if (!matches) return failed();

  // The email bucket only. Forgetting the IP bucket on success would let
  // someone with an account of their own reset it every few guesses by
  // logging into it.
  forget('login:email', emailKey);

  const token = signToken(user);
  return res.json({ token, user: publicUser(user) });
}

export async function me(req, res) {
  const user = await User.findById(req.userId);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  return res.json({ user: publicUser(user) });
}

/**
 * Every token this user holds stops working, this one included - the
 * answer to "I think someone has my login". $inc rather than a
 * read-modify-write so two presses cannot collapse into one bump.
 *
 * Open signaling sockets are closed too: each was authenticated once,
 * when it opened, and would otherwise outlive the token that opened it.
 * A media token already handed out still lapses on its own, within two
 * minutes.
 *
 * Push subscriptions go too. Each one is a browser that will keep
 * showing this account's doorbell alerts without ever presenting a
 * token, so "everyone else is out" has to include them.
 */
export async function signOutEverywhere(req, res) {
  await User.updateOne({ _id: req.userId }, { $inc: { tokenVersion: 1 } });
  await PushSubscription.deleteMany({ user: req.userId });
  disconnectUser(req.userId);
  return res.status(204).end();
}

/**
 * "Forgot password?" - emails a one-time link to choose a new one.
 *
 * Answers the same thing, at the same speed, whether or not the address
 * has an account. The reply goes out before the lookup, and the lookup
 * and the email happen afterwards: awaiting them would make a real
 * account measurably slower to answer than a made-up one, which tells a
 * script exactly what the identical wording was hiding.
 */
export async function forgotPassword(req, res) {
  const { email } = req.body || {};
  if (typeof email !== 'string' || email.length > MAX_EMAIL || !EMAIL_RE.test(email.trim())) {
    return res.status(400).json({ error: 'Enter the email address you signed up with' });
  }

  const emailKey = email.trim().toLowerCase();

  const perIp = consume('forgot:ip', req.ip, FORGOT_LIMIT_PER_IP);
  const perEmail = consume('forgot:email', emailKey, FORGOT_LIMIT_PER_EMAIL);
  if (!perIp.allowed || !perEmail.allowed) {
    return tooMany(res, Math.max(perIp.retryAfterMs, perEmail.retryAfterMs));
  }

  res.status(202).json({ ok: true });

  try {
    const user = await User.findOne({ email: emailKey });
    if (!user) return;

    // Only the newest link works. Someone who asks twice and opens the
    // first email would otherwise have two live ways into the account.
    await PasswordReset.deleteMany({ user: user._id });

    const token = randomBytes(32).toString('base64url');
    await PasswordReset.create({
      user: user._id,
      tokenHash: hashResetToken(token),
      expiresAt: new Date(Date.now() + RESET_TTL_MINUTES * 60 * 1000)
    });

    await sendPasswordResetEmail(user, token, RESET_TTL_MINUTES);
  } catch (err) {
    // The response has gone, so there is nobody left to tell but the log.
    console.error('[auth] password reset email failed:', err.message);
  }
}

/**
 * The link from that email, with a new password. Signs in on success.
 *
 * The link is consumed by the same operation that checks it -
 * findOneAndDelete - so two tabs submitting the one link cannot both
 * succeed. No rate limit: the token is 256 random bits, and bcrypt only
 * runs once one has matched.
 *
 * Changing the password signs out everywhere else, through the same
 * tokenVersion bump as the button in Settings. Someone resetting their
 * password is often doing it *because* somebody else got in, and leaving
 * that person's session alive would make the reset pointless.
 */
export async function resetPassword(req, res) {
  const { token, password } = req.body || {};

  if (typeof token !== 'string' || !token || typeof password !== 'string') {
    return res.status(400).json({ error: 'token and password are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const reset = await PasswordReset.findOneAndDelete({
    tokenHash: hashResetToken(token),
    expiresAt: { $gt: new Date() }
  });
  if (!reset) {
    return res.status(400).json({ error: 'This link has expired or has already been used' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await User.findOneAndUpdate(
    { _id: reset.user },
    { $set: { passwordHash }, $inc: { tokenVersion: 1 } },
    { new: true }
  );
  if (!user) {
    return res.status(400).json({ error: 'This link has expired or has already been used' });
  }

  disconnectUser(user._id.toString());
  // Same reason as signOutEverywhere: a browser someone else subscribed
  // would otherwise go on showing them this account's alerts.
  await PushSubscription.deleteMany({ user: user._id });
  // Whoever just proved they own the inbox should not then be locked out
  // by guesses someone else made at the old password.
  forget('login:email', user.email);

  sendPasswordChangedEmail(user).catch((err) => {
    console.error('[auth] password changed email failed:', err.message);
  });

  const sessionToken = signToken(user);
  return res.json({ token: sessionToken, user: publicUser(user) });
}

/** Your name: what greetings use, and what people you share with see. */
export async function updateMe(req, res) {
  const { name } = req.body || {};
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Your name cannot be empty' });
  }
  if (name.trim().length > MAX_NAME) {
    return res.status(400).json({ error: `Name must be at most ${MAX_NAME} characters` });
  }

  const user = await User.findByIdAndUpdate(req.userId, { $set: { name: name.trim() } }, { new: true });
  if (!user) return res.status(404).json({ error: 'User not found' });
  return res.json({ user: publicUser(user) });
}

/**
 * Checks the password of a signed-in user, for the two account actions
 * that ask for it again. Wrong guesses are charged to the same per-email
 * bucket as the login form - a stolen session must not become a way to
 * guess at the password with no limit.
 *
 * A wrong password is a 403, not a 401. The app reads any 401 on a
 * request that carried a token as "this session is over" and signs out
 * (api/client.js) - right for an expired token, and exactly wrong for a
 * typo in a form.
 *
 * Returns the user, or sends the refusal and returns null.
 */
async function confirmPassword(req, res, password) {
  const user = await User.findById(req.userId);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return null;
  }

  const perEmail = peek('login:email', user.email, LOGIN_LIMIT_PER_EMAIL);
  if (!perEmail.allowed) {
    tooMany(res, perEmail.retryAfterMs);
    return null;
  }

  if (typeof password !== 'string' || !(await bcrypt.compare(password, user.passwordHash))) {
    consume('login:email', user.email, LOGIN_LIMIT_PER_EMAIL);
    res.status(403).json({ error: 'That password is not right' });
    return null;
  }
  return user;
}

/**
 * Changing your password while signed in. Like a reset, it signs out
 * everywhere else and emails that it happened; unlike a reset, this
 * session carries on with a fresh token, and this browser keeps its
 * notifications if it says which subscription is its own.
 */
export async function changePassword(req, res) {
  const { currentPassword, newPassword, keepEndpoint } = req.body || {};

  if (typeof newPassword !== 'string' || newPassword.length < 8) {
    return res.status(400).json({ error: 'Your new password must be at least 8 characters' });
  }

  const user = await confirmPassword(req, res, currentPassword);
  if (!user) return undefined;

  const passwordHash = await bcrypt.hash(newPassword, 10);
  const updated = await User.findOneAndUpdate(
    { _id: user._id },
    { $set: { passwordHash }, $inc: { tokenVersion: 1 } },
    { new: true }
  );

  disconnectUser(String(updated._id));
  await PushSubscription.deleteMany({
    user: updated._id,
    ...(typeof keepEndpoint === 'string' && { endpoint: { $ne: keepEndpoint } })
  });
  forget('login:email', updated.email);

  sendPasswordChangedEmail(updated).catch((err) => {
    console.error('[auth] password changed email failed:', err.message);
  });

  return res.json({ token: signToken(updated), user: publicUser(updated) });
}

/**
 * Deletes the account, and with it every doorbell it owns - for everyone
 * those doorbells are shared with, clips included, exactly as "Delete
 * this doorbell" would. Doorbells it was only a member of are left, with
 * this person gone from them.
 *
 * Owned doorbells go first, so a failure partway leaves an account that
 * can try again rather than doorbells whose owner no longer exists.
 */
export async function deleteAccount(req, res) {
  const { password } = req.body || {};
  const user = await confirmPassword(req, res, password);
  if (!user) return undefined;

  const owned = await Membership.find({ user: user._id, role: 'owner' }).populate('device');
  for (const membership of owned) {
    if (membership.device) await purgeDevice(membership.device);
  }

  await Membership.deleteMany({ user: user._id });
  await PushSubscription.deleteMany({ user: user._id });
  await PasswordReset.deleteMany({ user: user._id });
  await User.deleteOne({ _id: user._id });

  disconnectUser(String(user._id), 'Account deleted');
  forget('login:email', user.email);

  return res.status(204).end();
}

