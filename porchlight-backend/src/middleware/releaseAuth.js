import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Who may publish a release: whoever holds RELEASE_TOKEN, which is the
 * publish script on the build machine and nobody else.
 *
 * A bearer secret rather than a user role, because publishing is not
 * something a person does in the app - it is the last step of a build, run
 * from the one machine that holds the signing key. The token alone cannot
 * put code on a doorbell: the bundle it uploads still has to carry a
 * signature RAUC accepts, and the key for that never comes near here.
 *
 * Without RELEASE_TOKEN set the endpoints answer 503, so a server that was
 * never given one has no publish endpoint at all rather than an open one.
 */
const digest = (value) => createHash('sha256').update(value).digest();

export function requireReleaseToken(req, res, next) {
  const expected = process.env.RELEASE_TOKEN;
  if (!expected) return res.status(503).json({ error: 'Publishing is not configured on this server' });

  const [scheme, token] = (req.headers.authorization || '').split(' ');
  // Compared as digests, so the comparison takes the same time whatever the
  // lengths - timingSafeEqual throws on unequal lengths, and a length check
  // in front of it would itself leak the token's length.
  if (scheme !== 'Bearer' || !token || !timingSafeEqual(digest(token), digest(expected))) {
    return res.status(401).json({ error: 'Not authorised to publish' });
  }
  next();
}
