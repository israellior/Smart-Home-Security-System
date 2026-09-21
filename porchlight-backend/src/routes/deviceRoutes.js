import { Router } from 'express';
import {
  listDevices,
  getDevice,
  createDevice,
  joinDevice,
  updateDevice,
  updatePreferences,
  markDeviceSeen,
  deleteDevice,
  listMembers,
  removeMember
} from '../controllers/deviceController.js';
import { listEvents, createEvent } from '../controllers/eventController.js';
import { requireAuth } from '../middleware/auth.js';
import { requireDeviceAccess, requireDeviceOwner } from '../middleware/deviceAccess.js';

export const deviceRoutes = Router();

deviceRoutes.use(requireAuth); // every route below requires a logged-in user

// Collection-level. /join is declared before the /:id routes so it's
// matched as a literal path rather than swallowed as a device id.
deviceRoutes.get('/', listDevices);
deviceRoutes.post('/', createDevice);
deviceRoutes.post('/join', joinDevice);

// Everything below is scoped to one device the caller is a member of.
// requireDeviceAccess loads req.device / req.membership; requireDeviceOwner
// stacks on top for the two actions members shouldn't have.
deviceRoutes.get('/:id', requireDeviceAccess, getDevice);
deviceRoutes.patch('/:id', requireDeviceAccess, updateDevice);
// Writes the caller's membership rather than the device, so it needs no
// owner check: it can only ever change the caller's own preferences.
deviceRoutes.patch('/:id/preferences', requireDeviceAccess, updatePreferences);
// Same shape: writes only the caller's own membership watermark.
deviceRoutes.post('/:id/seen', requireDeviceAccess, markDeviceSeen);
deviceRoutes.delete('/:id', requireDeviceAccess, requireDeviceOwner, deleteDevice);

deviceRoutes.get('/:id/members', requireDeviceAccess, listMembers);
// No requireDeviceOwner here: removing *yourself* is "leave", which any
// member may do. The controller distinguishes the two cases.
deviceRoutes.delete('/:id/members/:userId', requireDeviceAccess, removeMember);

deviceRoutes.get('/:deviceId/events', requireDeviceAccess, listEvents);
deviceRoutes.post('/:deviceId/events', requireDeviceAccess, createEvent);
