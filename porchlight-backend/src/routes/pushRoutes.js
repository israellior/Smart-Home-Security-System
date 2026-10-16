import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import {
  getPublicKey,
  saveSubscription,
  deleteSubscription,
  sendTest
} from '../controllers/pushController.js';

export const pushRoutes = Router();

pushRoutes.get('/key', getPublicKey);
pushRoutes.put('/subscriptions', requireAuth, saveSubscription);
pushRoutes.delete('/subscriptions', requireAuth, deleteSubscription);
pushRoutes.post('/test', requireAuth, sendTest);
