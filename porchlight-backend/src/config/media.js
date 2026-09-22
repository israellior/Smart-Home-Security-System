import { AccessToken, RoomServiceClient, TrackSource } from 'livekit-server-sdk';

/**
 * Live video and two-way talk, carried by LiveKit Cloud.
 *
 * The app server is never in the media path. The Pi publishes one stream
 * and LiveKit copies it out to each viewer; both ends connect *outward*,
 * so no home router has to accept an incoming connection and no TURN
 * relay is needed.
 *
 * What this server does is mint tokens. The API key and secret never
 * leave it, and minting is local signing with no call to LiveKit - which
 * is why a token can be short-lived without costing a round trip.
 *
 * Every mint goes through mintMediaToken(), so moving to self-hosted
 * LiveKit or to mediasoup later changes this module and no callers.
 */

const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;

export const mediaConfigured = Boolean(LIVEKIT_URL && LIVEKIT_API_KEY && LIVEKIT_API_SECRET);

// Short. A token is only needed to *join*; once connected the session
// persists, so a brief window costs nothing and narrows what a leaked
// token is worth. Combined with the membership check at mint time, this
// is what makes "removing someone revokes their access immediately" true
// rather than aspirational.
const TOKEN_TTL_SECONDS = 120;

/** One room per doorbell. */
export function roomName(deviceId) {
  return `device-${deviceId}`;
}

/**
 * The four kinds of participant, and the differences between them are
 * the security model rather than configuration.
 *
 * The Pi holds TWO tokens rather than one. Split this way the publishing
 * half *literally cannot* subscribe: `canSubscribe: false` is not a
 * policy this server enforces, it is a claim inside the token that
 * LiveKit itself rejects on. A leaked publisher token cannot be turned
 * into a way to watch the house. The split also lands cleanly on the two
 * processes already running on the Pi.
 *
 * Viewers are subscribe-only by default. Only the one participant
 * currently holding the talk floor is granted publish, and then only for
 * `microphone` - never camera, never screen share. `canPublishSources`
 * supersedes `canPublish` in LiveKit, so this is a whitelist rather than
 * a request.
 */
const GRANTS = {
  publisher: {
    identity: (deviceId) => `device:${deviceId}:pub`,
    grant: {
      canPublish: true,
      // Named explicitly rather than left open. `canPublish: true` alone
      // permits every source including screen share, which a doorbell
      // has no concept of - and the viewer side is already a whitelist,
      // so leaving this one unconstrained was an asymmetry with no
      // reason behind it.
      canPublishSources: [TrackSource.CAMERA, TrackSource.MICROPHONE],
      canSubscribe: false,
      canPublishData: false
    }
  },
  listener: {
    identity: (deviceId) => `device:${deviceId}:sub`,
    grant: { canPublish: false, canSubscribe: true, canPublishData: false }
  },
  viewer: {
    identity: (deviceId, userId) => `user:${userId}`,
    grant: { canPublish: false, canSubscribe: true, canPublishData: false }
  },
  talker: {
    identity: (deviceId, userId) => `user:${userId}`,
    grant: {
      canPublish: true,
      canPublishSources: [TrackSource.MICROPHONE],
      canSubscribe: true,
      canPublishData: false
    }
  }
};

export const MEDIA_TOKEN_KINDS = Object.keys(GRANTS);

/**
 * The one place a media token is made.
 *
 * `kind` is looked up in a table rather than assembled from arguments,
 * so there is no call site that can ask for "publisher, but also able to
 * subscribe". The permissions belong to the kind.
 */
export async function mintMediaToken(kind, { deviceId, userId, name } = {}) {
  if (!mediaConfigured) throw new Error('Live media is not configured');

  const spec = GRANTS[kind];
  if (!spec) throw new Error(`Unknown media token kind "${kind}"`);

  const identity = spec.identity(deviceId, userId);
  const room = roomName(deviceId);

  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity,
    name: name || identity,
    ttl: TOKEN_TTL_SECONDS
  });

  at.addGrant({ roomJoin: true, room, ...spec.grant });

  return {
    token: await at.toJwt(),
    url: LIVEKIT_URL,
    room,
    identity,
    expiresAt: new Date(Date.now() + TOKEN_TTL_SECONDS * 1000).toISOString()
  };
}

/**
 * Warns if this server's clock has drifted.
 *
 * Every token carries `nbf` set to the moment it was minted, and the SDK
 * hardcodes that - there is no way to backdate it. So a server clock
 * running fast issues tokens that are not yet valid, and LiveKit's
 * leeway is about a minute. The failure mode is the bad kind: tokens
 * mint perfectly, every endpoint returns 200, and joins fail somewhere
 * far away with a message about the token.
 *
 * Nothing here can fix a wrong clock, but it can stop it being silent.
 * Any HTTPS response carries a Date header, so LiveKit itself is the
 * reference - no extra dependency and no NTP client.
 *
 * Deliberately not awaited at startup: a media check must not be able to
 * stop the API from serving alerts.
 */
export async function checkClockSkew() {
  if (!mediaConfigured) return null;

  try {
    const res = await fetch(LIVEKIT_URL.replace(/^wss:/, 'https:'), { method: 'HEAD' });
    const theirs = res.headers.get('date');
    if (!theirs) return null;

    const skewMs = Date.now() - new Date(theirs).getTime();
    const skew = Math.round(skewMs / 1000);

    // A Date header has one-second resolution and the round trip costs
    // something, so a few seconds means nothing. Tens of seconds is
    // heading for the leeway.
    if (Math.abs(skew) >= 20) {
      console.warn(
        `CLOCK SKEW: this server is ${skew > 0 ? 'ahead of' : 'behind'} LiveKit by ~${Math.abs(skew)}s. ` +
          'Media tokens carry nbf = mint time and LiveKit allows about a minute, so joins will ' +
          'start failing. Sync this machine\'s clock.'
      );
    }
    return skew;
  } catch (err) {
    // Not reachable is not this check's problem to report.
    return null;
  }
}

/**
 * Changing a live participant's permissions, which is how push-to-talk
 * works without anyone reconnecting.
 *
 * Handing out a new token would mean tearing down and rebuilding the
 * connection every time somebody pressed a button - seconds of dead air
 * in the middle of a conversation. This flips the permission on the
 * session that is already up.
 */
const roomService = mediaConfigured
  ? new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
  : null;

export async function setCanTalk(deviceId, userId, canTalk) {
  if (!roomService) throw new Error('Live media is not configured');

  const permission = {
    canPublish: canTalk,
    canPublishSources: canTalk ? [TrackSource.MICROPHONE] : [],
    canSubscribe: true,
    canPublishData: false
  };

  try {
    await roomService.updateParticipant(roomName(deviceId), `user:${userId}`, undefined, permission);
    return true;
  } catch (err) {
    // Not being in the room is the ordinary case, not a failure: a
    // viewer who closed their laptop still holds the floor in our state
    // until someone else takes it, and revoking them then is a no-op.
    // Treated as "nothing to change" so releasing a floor can never fail
    // in a way that wedges it.
    console.warn(`Could not set talk permission for user:${userId} on ${deviceId}: ${err.message}`);
    return false;
  }
}
