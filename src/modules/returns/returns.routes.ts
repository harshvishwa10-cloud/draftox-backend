import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { inquiryLimiter } from '../../middleware/rateLimit.js';
import { createReturnRequest, listOrderReturnRequests } from './returns.controller.js';

const router = Router();

// Customer-facing return routes (mounted alongside orders at /api/v1/orders).
// They carry the same CSRF/rate-limit posture as order creation.
router.post('/:orderId/returns', inquiryLimiter, requireAuth, createReturnRequest);
router.get('/:orderId/returns', requireAuth, listOrderReturnRequests);

export default router;