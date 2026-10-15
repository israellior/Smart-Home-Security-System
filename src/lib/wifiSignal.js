/**
 * What a doorbell's Wi-Fi signal means, in words and in bars.
 *
 * The doorbell reports dBm, which is the honest number and a useless one
 * to show anybody: -71 says nothing to a person standing in a hallway.
 * One place turns it into words, like deviceStatus.js does for presence,
 * so the device page and the live view cannot disagree about the same
 * doorbell.
 *
 * The thresholds are about what the doorbell does with the link, not
 * about Wi-Fi in general. A live call is a steady upload of video from
 * the far end of somebody's house; that holds up comfortably above about
 * -67 dBm and starts to stutter in the low -70s, which is where "weak"
 * begins and where the app starts saying why the picture is breaking up.
 */

const LEVELS = [
  { min: -60, level: 3, label: 'Strong', weak: false },
  { min: -70, level: 2, label: 'Good', weak: false },
  { min: -80, level: 1, label: 'Weak', weak: true },
  { min: -Infinity, level: 0, label: 'Very weak', weak: true }
];

/**
 * `{ level, label, weak, rssi }` for a reading, or null for no reading -
 * a doorbell that has not reported, is offline, or is not on Wi-Fi.
 */
export function wifiSignal(rssi) {
  if (rssi === null || rssi === undefined || !Number.isFinite(rssi)) return null;
  const found = LEVELS.find((l) => rssi >= l.min);
  return { ...found, rssi };
}
