import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { authLimiter } from '../../middleware/rateLimit.js';
import * as authController from './auth.controller.js';
import * as firebaseController from './firebase.controller.js';

const router = Router();

router.post('/register', authLimiter, authController.register);
router.post('/login', authLimiter, authController.login);
router.post('/logout', authController.logout);
router.get('/me', requireAuth, authController.me);
router.post('/forgot-password', authLimiter, authController.forgotPassword);
router.post('/reset-password', authLimiter, authController.resetPassword);
router.get('/providers', authController.providers);

// Google OAuth
router.get('/google', authLimiter, authController.googleRedirect);
router.get('/google/callback', authController.googleCallback);

// Firebase Authentication. The browser posts a Firebase ID token; the server
// verifies it and issues a hardened session cookie (see firebase.service.ts).
router.post('/firebase/session', authLimiter, firebaseController.createSession);
router.post('/firebase/logout', firebaseController.logout);

export default router;
