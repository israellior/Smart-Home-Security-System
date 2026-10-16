import { Router } from 'express';
import {
  register,
  login,
  me,
  signOutEverywhere,
  forgotPassword,
  resetPassword
} from '../controllers/authController.js';
import { requireAuth } from '../middleware/auth.js';

export const authRoutes = Router();

authRoutes.post('/register', register);
authRoutes.post('/login', login);
authRoutes.post('/forgot-password', forgotPassword);
authRoutes.post('/reset-password', resetPassword);
authRoutes.get('/me', requireAuth, me);
authRoutes.post('/sign-out-everywhere', requireAuth, signOutEverywhere);
