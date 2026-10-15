import jwt from 'jsonwebtoken';
import { User } from '../models/User.js';

/**
 * Turns a presented JWT into the user it speaks for, or null.
 *
 * A valid signature is not enough on its own: the token also carries the
 * user's tokenVersion from when it was issued, and it is only good while
 * that still matches. "Sign out everywhere" bumps the version, which is
 * what lets a stolen token be killed before its seven days are up -
 * without that, a signed token is unrevocable by construction.
 *
 * Tokens from before versions existed carry no `ver`, and read as 0, the
 * same as a user who has never signed out everywhere. So adding this
 * logged nobody out.
 *
 * The cost is one indexed read by _id per request. Database errors are
 * left to throw: a Mongo blip must surface as a 500, never as a 401 -
 * see deviceAuth.js for why that distinction is load-bearing on the
 * signaling socket.
 *
 * Shared by requireAuth and the browser side of the signaling socket, so
 * the two can never disagree about whether a token is still good.
 */
export async function verifyUserToken(token) {
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch (err) {
    return null;
  }

  const user = await User.findById(payload.sub, { tokenVersion: 1 }).lean();
  if (!user) return null;
  if ((payload.ver ?? 0) !== (user.tokenVersion ?? 0)) return null;
  return String(payload.sub);
}

// Reads "Authorization: Bearer <token>", verifies it, and attaches the
// user's id as req.userId. Any route that needs a logged-in user wraps
// its handler with this.
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }

  const userId = await verifyUserToken(token);
  if (!userId) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  req.userId = userId;
  next();
}
