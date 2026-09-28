import { Router } from 'express';
import { getHardwareSelf } from '../controllers/hardwareController.js';
import { getPublisherToken, getListenerToken } from '../controllers/mediaController.js';
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

// The doorbell's two media tokens. Separate endpoints rather than one
// with a role parameter: a parameter is a thing that can be passed
// wrong, and these two carry deliberately different rights. The
// publisher can send camera and mic but cannot subscribe to anything;
// the listener can only subscribe. There is no path through the
// publisher endpoint that mints a subscriber.
hardwareRoutes.post('/:deviceId/media-token/publisher', requireDevice, getPublisherToken);
hardwareRoutes.post('/:deviceId/media-token/listener', requireDevice, getListenerToken);
