import { Router } from 'express';
import { listDevices, createDevice, updateDevice } from '../controllers/deviceController.js';
import { listEvents, createEvent } from '../controllers/eventController.js';
import { requireAuth } from '../middleware/auth.js';

export const deviceRoutes = Router();

deviceRoutes.use(requireAuth); // every route below requires a logged-in user

deviceRoutes.get('/', listDevices);
deviceRoutes.post('/', createDevice);
deviceRoutes.patch('/:id', updateDevice);

deviceRoutes.get('/:deviceId/events', listEvents);
deviceRoutes.post('/:deviceId/events', createEvent);
