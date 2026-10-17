import { Router } from 'express';
import { optionalAuth, requireAuth } from '../../middleware/auth.js';
import { inquiryLimiter } from '../../middleware/rateLimit.js';
import { createContactInquiry, listContactInquiries } from './contact.controller.js';

const router = Router();

router.post('/', inquiryLimiter, optionalAuth, createContactInquiry);
router.get('/', requireAuth, listContactInquiries);

export default router;
