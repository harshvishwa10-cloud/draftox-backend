import { Router } from 'express';
import { trackingLimiter } from '../../middleware/rateLimit.js';
import { getTracking } from './tracking.controller.js';

const router = Router();

router.get('/:token', trackingLimiter, getTracking);

export default router;
