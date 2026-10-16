import { randomUUID } from 'node:crypto';
import * as registry from '../signaling/registry.js';

/**
 * Changing a doorbell's wi-fi from the app, while it is online.
 *
 * Nothing is stored. The app asks, this hands the request to the doorbell's
 * socket, and whatever the doorbell reports - the networks it can see, then
 * "joining", then "connected" or "failed" - is passed straight to everyone
 * with the doorbell open. A wi-fi password passes through this process and
 * is never written anywhere or logged.
 *
 * The doorbell does the careful part: it keeps its old network until the new
 * one has reached this server, and goes back to the old one if it does not.
 * See pi/porchlight-wifi.py in the device repo.
 *
 * A doorbell whose network has gone cannot be asked anything; that case is
 * the setup network it raises after a restart, and the app says how.
 */

function send(socket, payload) {
  if (!socket || socket.readyState !== socket.OPEN) return false;
  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

function toBrowsers(deviceKey, payload) {
  for (const socket of registry.browserSockets(deviceKey)) send(socket, payload);
}

/** `{ sent, reason }` - reason is offline or unsupported. */
function deviceSocketFor(device) {
  const socket = registry.deviceSocket(String(device._id));
  if (!socket) return { reason: 'offline' };
  if (!socket.ctx?.wifi) return { reason: 'unsupported' };
  return { socket };
}

export function requestScan(device) {
  const { socket, reason } = deviceSocketFor(device);
  if (!socket) return { sent: false, reason };
  return { sent: send(socket, { type: 'wifi-scan' }) };
}

export function requestJoin(device, ssid, psk) {
  const { socket, reason } = deviceSocketFor(device);
  if (!socket) return { sent: false, reason };
  const id = randomUUID();
  const sent = send(socket, { type: 'wifi-join', id, ssid, psk });
  if (sent) console.log(`Wi-Fi: ${device.deviceId} asked to move to "${ssid}"`);
  return { sent, id };
}

const MAX_NETWORKS = 30;

/** What the doorbell saw, trimmed to what the app shows. */
export function relayNetworks(device, frame) {
  const networks = (Array.isArray(frame.networks) ? frame.networks : [])
    .filter((n) => n && typeof n.ssid === 'string' && n.ssid && n.ssid.length <= 32)
    .slice(0, MAX_NETWORKS)
    .map((n) => ({
      ssid: n.ssid,
      signal: Number.isFinite(n.signal) ? Math.max(0, Math.min(100, Math.round(n.signal))) : 0,
      secure: n.secure !== false
    }));
  const current = typeof frame.current === 'string' ? frame.current.slice(0, 64) : null;
  toBrowsers(String(device._id), { type: 'wifi-networks', networks, current });
}

const STATES = ['joining', 'connected', 'failed'];

export function relayStatus(device, frame) {
  if (!STATES.includes(frame.state) || typeof frame.id !== 'string') return;
  const text = (v) => (typeof v === 'string' ? v.slice(0, 300) : null);
  const payload = {
    type: 'wifi-status',
    id: frame.id,
    state: frame.state,
    ssid: text(frame.ssid),
    previous: text(frame.previous),
    error: text(frame.error)
  };
  if (frame.state !== 'joining') {
    console.log(`Wi-Fi: ${device.deviceId} ${frame.state} "${payload.ssid}"${payload.error ? ` - ${payload.error}` : ''}`);
  }
  toBrowsers(String(device._id), payload);
}
