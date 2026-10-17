import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { inquiryLimiter } from '../../middleware/rateLimit.js';
import {
  createRazorpayOrder,
  paymentStatus,
  verifyRazorpayPayment,
} from './payments.controller.js';

const router = Router();

// NOTE: the Razorpay webhook is mounted separately in app.ts (raw body,
// before CSRF) — it must not pass through the JSON parser or CSRF check.
router.get('/status', paymentStatus);
router.post('/razorpay/order', inquiryLimiter, requireAuth, createRazorpayOrder);
router.post('/razorpay/verify', inquiryLimiter, requireAuth, verifyRazorpayPayment);

export default router;
