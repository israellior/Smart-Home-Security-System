import { Event } from '../models/Event.js';

// Both handlers run behind requireDeviceAccess, so req.device is already
// loaded and already confirmed to belong to this caller. That's why the
// old assertOwnsDevice helper is gone - the check moved to the route
// definition, where forgetting it means the handler has no device at all
// rather than quietly reading someone else's.

export async function listEvents(req, res) {
  const events = await Event.find({ device: req.device._id }).sort({ createdAt: -1 }).limit(50);
  return res.json({ events });
}

export async function createEvent(req, res) {
  const { type, meta } = req.body;

  if (!['motion', 'ring'].includes(type)) {
    return res.status(400).json({ error: 'type must be "motion" or "ring"' });
  }

  const event = await Event.create({ device: req.device._id, type, meta: meta || {} });
  return res.status(201).json({ event });
}
