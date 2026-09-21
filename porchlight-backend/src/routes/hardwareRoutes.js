import { Router } from 'express';
import { getHardwareSelf } from '../controllers/hardwareController.js';
import { requireDevice } from '../middleware/deviceAuth.js';

/**
 * Routes real hardware calls, mounted at /api/devices *before* the
 * user-authenticated deviceRoutes so these paths match first and never
 * reach requireAuth.
 *
 * The two routers share a prefix but not a key space: user routes address
 * a device by Mongo id, these address it by its slug. That is not a
 * collision waiting to happen - requireDeviceAccess already rejects
 * anything that isn't a valid ObjectId - but it is the reason every route
 * here uses :deviceId rather than :id, so a handler can never be unsure
 * which one it was handed.
 *
 * There is no enrolment route. Devices are provisioned offline by
 * scripts/mint-device.mjs, which is what lets the app have no
 * unauthenticated endpoints at all.
 */
export const hardwareRoutes = Router();

hardwareRoutes.get('/:deviceId/self', requireDevice, getHardwareSelf);

// Media token endpoints (publisher and listener) mount here too, on the
// same requireDevice, once LiveKit lands. See docs/server-brief.md.
