import { Router } from 'express';
import { optionalAuth, requireAuth } from '../../middleware/auth.js';
import { inquiryLimiter } from '../../middleware/rateLimit.js';
import { createSupportRequest, listSupportRequests } from './support.controller.js';

const router = Router();

router.post('/', inquiryLimiter, optionalAuth, createSupportRequest);
router.get('/', requireAuth, listSupportRequests);

export default router;
