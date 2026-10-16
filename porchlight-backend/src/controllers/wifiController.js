import { requestScan, requestJoin } from '../services/wifi.js';

const REFUSALS = {
  offline: [409, 'The doorbell is offline.'],
  unsupported: [409, 'This doorbell needs a software update before it can change networks.']
};

function refuse(res, reason) {
  const [status, error] = REFUSALS[reason] || [502, 'The doorbell could not be reached.'];
  return res.status(status).json({ error });
}

/**
 * Ask the doorbell what networks it can see. The answer arrives on the
 * socket as `wifi-networks`, a few seconds later - a scan takes that long,
 * and holding an HTTP request open for it would be the slow way round.
 */
export function scanWifi(req, res) {
  const result = requestScan(req.device);
  if (!result.sent) return refuse(res, result.reason);
  return res.status(202).json({ ok: true });
}

/**
 * Move the doorbell to another network. Any member, like the other
 * settings: the doorbell keeps its old network unless the new one works, so
 * this cannot strand it. Progress arrives on the socket as `wifi-status`,
 * matched on the id returned here.
 */
export function joinWifi(req, res) {
  const { ssid, psk = '' } = req.body || {};
  if (typeof ssid !== 'string' || !ssid.trim() || Buffer.byteLength(ssid) > 32) {
    return res.status(400).json({ error: 'Choose a network' });
  }
  // WPA2's limits. Empty is an open network.
  if (typeof psk !== 'string' || (psk && (psk.length < 8 || psk.length > 63))) {
    return res.status(400).json({ error: 'A Wi-Fi password is 8 to 63 characters' });
  }

  const result = requestJoin(req.device, ssid, psk);
  if (!result.sent) return refuse(res, result.reason);
  return res.status(202).json({ id: result.id });
}
