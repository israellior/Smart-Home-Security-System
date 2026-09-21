/**
 * Who is currently connected, per doorbell.
 *
 * Keyed by Device._id rather than by the `porch-1` slug, because every
 * principal can resolve to a Device document but only paired hardware has
 * a slug. One key means one lookup and no second addressing scheme to
 * keep in step.
 */

// Close codes. 4000+ is the application-private range, so these never
// collide with the protocol's own.
export const CLOSE_REPLACED = 4001;
export const CLOSE_UNAUTHORIZED = 4002;
export const CLOSE_NO_HELLO = 4003;

/**
 * THE ROLE TRAP.
 *
 * `webrtc-video.py` already signs in as 'pi', and the old LAN stub treats
 * any second 'pi' hello as a replacement - it closes the first socket. So
 * the daemon must NOT be a 'pi'. It gets its own role, and replacement is
 * scoped per role: a reconnecting daemon displaces only the previous
 * daemon.
 *
 * Give porchlightd 'pi' instead and every reconnect silently kicks the
 * media script off its socket, which presents as video that randomly
 * stops working rather than as an auth problem - so it would be debugged
 * in the wrong place entirely.
 */
export const ROLE_DEVICE = 'device'; // porchlightd - alerts, viewer requests
export const ROLE_PI = 'pi'; // webrtc-video.py - media only
export const ROLE_BROWSER = 'browser'; // a person watching

// Exactly one socket per doorbell for each of these; a newcomer replaces
// its predecessor. Browsers are a set - 1-5 of them is the normal case.
const SINGLETON_ROLES = [ROLE_DEVICE, ROLE_PI];

const rooms = new Map();

function room(deviceKey) {
  let found = rooms.get(deviceKey);
  if (!found) {
    found = { [ROLE_DEVICE]: null, [ROLE_PI]: null, browsers: new Set() };
    rooms.set(deviceKey, found);
  }
  return found;
}

/**
 * Registers a socket and returns the one it displaced, if any.
 *
 * The caller closes the loser rather than this doing it, so the registry
 * stays a data structure and the socket lifecycle stays in one place.
 */
export function add(deviceKey, role, socket) {
  const r = room(deviceKey);

  if (SINGLETON_ROLES.includes(role)) {
    const previous = r[role];
    r[role] = socket;
    // Identity check, not a truthiness one: a socket replacing itself
    // would otherwise be told to close, killing the connection that just
    // succeeded.
    return previous && previous !== socket ? previous : null;
  }

  r.browsers.add(socket);
  return null;
}

/**
 * Removes a socket, but only if it is still the registered one.
 *
 * The guard is what makes a replaced connection's late 'close' event
 * harmless. Without it, the sequence "daemon reconnects, old socket
 * closes a moment later" would clear the *new* socket from the registry,
 * and the doorbell would be connected but unaddressable - the kind of
 * fault that only appears under a flaky network, which is the only place
 * this code ever runs.
 */
export function remove(deviceKey, role, socket) {
  const r = rooms.get(deviceKey);
  if (!r) return false;

  let removed = false;
  if (SINGLETON_ROLES.includes(role)) {
    if (r[role] === socket) {
      r[role] = null;
      removed = true;
    }
  } else {
    removed = r.browsers.delete(socket);
  }

  if (!r[ROLE_DEVICE] && !r[ROLE_PI] && r.browsers.size === 0) rooms.delete(deviceKey);
  return removed;
}

export function deviceSocket(deviceKey) {
  return rooms.get(deviceKey)?.[ROLE_DEVICE] || null;
}

export function browserSockets(deviceKey) {
  const r = rooms.get(deviceKey);
  return r ? [...r.browsers] : [];
}

/** Is the *hardware* on the other end right now - not the media script. */
export function isDeviceOnline(deviceKey) {
  return Boolean(rooms.get(deviceKey)?.[ROLE_DEVICE]);
}

export function stats() {
  let browsers = 0;
  let devices = 0;
  let pis = 0;
  for (const r of rooms.values()) {
    browsers += r.browsers.size;
    if (r[ROLE_DEVICE]) devices++;
    if (r[ROLE_PI]) pis++;
  }
  return { rooms: rooms.size, devices, pis, browsers };
}

export function clear() {
  rooms.clear();
}
