import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireReleaseToken } from '../middleware/releaseAuth.js';
import {
  getLatestRelease,
  createRelease,
  publishRelease
} from '../controllers/updateController.js';

export const releaseRoutes = Router();

// For the app: what the doorbells are being brought to, and what is new in it.
releaseRoutes.get('/latest', requireAuth, getLatestRelease);

// For the publish script on the build machine. See middleware/releaseAuth.js.
releaseRoutes.post('/', requireReleaseToken, createRelease);
releaseRoutes.post('/:version/publish', requireReleaseToken, publishRelease);
