import { Device } from '../models/Device.js';
import { Event } from '../models/Event.js';

async function assertOwnsDevice(deviceId, userId) {
  const device = await Device.findOne({ _id: deviceId, owner: userId });
  return device;
}

export async function listEvents(req, res) {
  const { deviceId } = req.params;
  const device = await assertOwnsDevice(deviceId, req.userId);
  if (!device) {
    return res.status(404).json({ error: 'Device not found' });
  }

  const events = await Event.find({ device: deviceId }).sort({ createdAt: -1 }).limit(50);
  return res.json({ events });
}

export async function createEvent(req, res) {
  const { deviceId } = req.params;
  const { type, meta } = req.body;

  if (!['motion', 'ring'].includes(type)) {
    return res.status(400).json({ error: 'type must be "motion" or "ring"' });
  }

  const device = await assertOwnsDevice(deviceId, req.userId);
  if (!device) {
    return res.status(404).json({ error: 'Device not found' });
  }

  const event = await Event.create({ device: deviceId, type, meta: meta || {} });
  return res.status(201).json({ event });
}
