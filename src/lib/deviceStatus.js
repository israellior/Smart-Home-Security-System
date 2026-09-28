/**
 * The four states a doorbell can be in, and what to say about each.
 *
 * `connected` is a boolean, which means a doorbell that has never been
 * plugged in and one that is unplugged look identical - and those are the
 * two halves of setup, with completely different next actions. The server
 * derives a four-state `status` instead (see models/Device.js); this is
 * the one place the app turns it into words, so the list row and the
 * device page cannot describe the same doorbell differently.
 *
 *   online           a socket is open right now
 *   never-connected  provisioned, has never reported in - i.e. mid-setup
 *   offline          has reported in before, but not now
 *   unprovisioned    no hardware exists for this doorbell yet
 */

const STATUS = {
  online: {
    tone: 'online',
    label: 'Connected',
    // Present tense and specific: this is the only state where the
    // doorbell is actually doing its job.
    detail: 'Connected and watching'
  },
  'never-connected': {
    tone: 'waiting',
    label: 'Waiting for first connection',
    detail: 'Waiting for your doorbell to come online for the first time'
  },
  offline: {
    tone: 'problem',
    label: 'Offline',
    detail: 'Offline — check its power and wi-fi'
  },
  unprovisioned: {
    tone: 'idle',
    label: 'No hardware yet',
    detail: 'No doorbell connected yet'
  }
};

// Anything unrecognised reads as the most cautious of the four rather than
// rendering "undefined" at somebody. A server that grows a fifth state
// should show up as a missing label here, not as a broken row.
const FALLBACK = STATUS.unprovisioned;

/**
 * The status to render, with live presence folded in.
 *
 * The socket outranks the device list, because the list was fetched once
 * and the socket is watching - but only once it has an opinion. Until then
 * (`liveConnected === null`) the stored status stands, so the page doesn't
 * flicker through "offline" on every load.
 *
 * Recomputed here rather than patching `connected` and hoping the server's
 * `status` keeps up: they are derived from the same inputs, and the one
 * the socket just changed is the input.
 */
export function deviceStatus(device, liveConnected = null) {
  if (!device) return 'unprovisioned';
  if (liveConnected === null || liveConnected === undefined) {
    return device.status || 'unprovisioned';
  }
  if (!device.provisioned) return 'unprovisioned';
  if (liveConnected) return 'online';
  // `lastContactAt` is what separates the two offline-looking states, and
  // it is written the moment a doorbell first authenticates - over HTTPS
  // during wi-fi setup, seconds before its socket ever comes up.
  return device.lastContactAt ? 'offline' : 'never-connected';
}

export function statusLabel(status) {
  return (STATUS[status] || FALLBACK).label;
}

export function statusDetail(status) {
  return (STATUS[status] || FALLBACK).detail;
}

/** 'online' | 'waiting' | 'problem' | 'idle' - for the CSS, not for text. */
export function statusTone(status) {
  return (STATUS[status] || FALLBACK).tone;
}

/**
 * Whether this doorbell is mid-setup, and the page should keep asking.
 *
 * The moment that ends the wait is an HTTPS call the device makes during
 * wi-fi setup, not a socket frame - the setup service's last check is
 * `GET /api/devices/<id>/self`, and that lands seconds *before* the
 * daemon's socket comes up. Nothing pushes it to the browser, so the one
 * screen that is waiting on it has to poll. Every other screen does not,
 * which is why this is a question rather than an interval.
 */
export function isAwaitingFirstContact(status) {
  return status === 'never-connected';
}
