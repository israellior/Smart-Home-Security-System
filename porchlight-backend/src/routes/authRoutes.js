import { Router } from 'express';
import {
  register,
  login,
  me,
  signOutEverywhere,
  forgotPassword,
  resetPassword,
  updateMe,
  changePassword,
  deleteAccount
} from '../controllers/authController.js';
import { requireAuth } from '../middleware/auth.js';

export const authRoutes = Router();

authRoutes.post('/register', register);
authRoutes.post('/login', login);
authRoutes.post('/forgot-password', forgotPassword);
authRoutes.post('/reset-password', resetPassword);
authRoutes.get('/me', requireAuth, me);
authRoutes.patch('/me', requireAuth, updateMe);
authRoutes.delete('/me', requireAuth, deleteAccount);
authRoutes.post('/change-password', requireAuth, changePassword);
authRoutes.post('/sign-out-everywhere', requireAuth, signOutEverywhere);
