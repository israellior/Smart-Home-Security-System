/**
 * What a doorbell may ask about itself.
 *
 * Deliberately thin. Devices are provisioned offline by
 * scripts/mint-device.mjs, so there is no enrolment endpoint here and no
 * unauthenticated route anywhere in the app - a Pi arrives already
 * holding its credential or it does not arrive at all.
 *
 * Media token endpoints will mount alongside this on the same
 * requireDevice middleware. See docs/server-brief.md in the device repo.
 */

/**
 * The device's own view of itself, and the smoke test for a freshly
 * flashed Pi: if this returns 200, its credential works.
 *
 * Returns identity and the settings that change how the hardware
 * behaves. Deliberately not the share code, the member list, or anything
 * else about the people involved - a doorbell bolted to someone's porch
 * is the least physically secure thing in this system, and it has no
 * reason to know who lives there.
 */
export async function getHardwareSelf(req, res) {
  const { hardware } = req;

  return res.json({
    device: {
      deviceId: hardware.deviceId,
      name: hardware.name,
      location: hardware.location,
      sensitivity: hardware.sensitivity,
      provisionedAt: hardware.provisionedAt,
      lastContactAt: hardware.lastContactAt
    }
  });
}
