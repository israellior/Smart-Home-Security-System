import { Router } from 'express';
import { createUploadUrl, confirmUpload } from '../controllers/clipController.js';
import { requireDevice } from '../middleware/deviceAuth.js';

/**
 * Mounted at /api/clips. Device credentials only - a person never uploads
 * a clip, and playback lives under /api/devices/:deviceId/events/... with
 * the rest of the user-facing routes.
 *
 * No :deviceId in these paths, on purpose. The device comes from the
 * credential, which is the only authority worth having: a path segment
 * is something a caller chooses, and eventIds are unique per doorbell
 * rather than globally, so the credential is what makes
 * /api/clips/<eventId> unambiguous.
 */
export const clipRoutes = Router();

clipRoutes.post('/:eventId/upload-url', requireDevice, createUploadUrl);
clipRoutes.post('/:eventId/confirm', requireDevice, confirmUpload);
