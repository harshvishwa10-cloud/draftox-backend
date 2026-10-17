import { Router } from 'express';
import { optionalAuth, requireAuth } from '../../middleware/auth.js';
import { inquiryLimiter } from '../../middleware/rateLimit.js';
import { createProductInquiry, listProductInquiries } from './productInquiry.controller.js';

const router = Router();

router.post('/', inquiryLimiter, optionalAuth, createProductInquiry);
router.get('/', requireAuth, listProductInquiries);

export default router;
