import { Router } from 'express';
import { provisionDevice, getHardwareSelf } from '../controllers/provisioningController.js';
import { requireDevice } from '../middleware/deviceAuth.js';

/**
 * The two routers real hardware talks to. Kept in one file because they
 * are two halves of one story, but mounted separately because they
 * authenticate completely differently.
 */

/**
 * Mounted at /api/provision. No auth middleware, by necessity - a
 * factory-fresh Pi has no credential to present. The pairing code in the
 * body is the credential, and provisioningController explains what makes
 * that safe.
 */
export const provisioningRoutes = Router();

provisioningRoutes.post('/', provisionDevice);

/**
 * Mounted at /api/devices, *before* the user-authenticated deviceRoutes,
 * so these paths are matched first and never reach requireAuth.
 *
 * The two routers share a prefix but not a key space: user routes address
 * a device by Mongo id, these address it by its slug. That is not a
 * collision waiting to happen - requireDeviceAccess already rejects
 * anything that isn't a valid ObjectId - but it is the reason every route
 * here uses :deviceId rather than :id, so a handler can never be unsure
 * which one it was handed.
 */
export const hardwareRoutes = Router();

hardwareRoutes.get('/:deviceId/self', requireDevice, getHardwareSelf);

// Media token endpoints (publisher and listener) mount here too, on the
// same requireDevice, once LiveKit lands. See docs/server-brief.md.
