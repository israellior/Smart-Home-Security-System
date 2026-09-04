import { Device } from '../models/Device.js';

// A user might have zero devices (before they've "connected" one) or,
// in principle, more than one - the frontend currently just uses the
// first one, but the API itself isn't limited to that.

export async function listDevices(req, res) {
  const devices = await Device.find({ owner: req.userId }).sort({ createdAt: 1 });
  return res.json({ devices });
}

export async function createDevice(req, res) {
  const { name, location } = req.body;
  const device = await Device.create({
    owner: req.userId,
    name: name || 'Front Door',
    location: location || ''
  });
  return res.status(201).json({ device });
}

export async function updateDevice(req, res) {
  const { id } = req.params;
  const allowedFields = ['name', 'location', 'sensitivity', 'notifMotion', 'notifRing', 'notifDaily'];

  const device = await Device.findOne({ _id: id, owner: req.userId });
  if (!device) {
    // Same response whether it doesn't exist or belongs to someone else -
    // don't leak which one it is.
    return res.status(404).json({ error: 'Device not found' });
  }

  for (const field of allowedFields) {
    if (field in req.body) {
      device[field] = req.body[field];
    }
  }

  await device.save();
  return res.json({ device });
}
