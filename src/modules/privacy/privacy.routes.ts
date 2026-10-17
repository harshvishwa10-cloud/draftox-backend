import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { getPrivacyPreferences, updatePrivacyPreferences } from './privacy.controller.js';

const router = Router();

router.use(requireAuth);
// The global generalLimiter (mounted in app.ts) already rate-limits these
// routes; a second generalLimiter here would double-count each request and
// halve the effective limit.
router.get('/preferences', getPrivacyPreferences);
router.patch('/preferences', updatePrivacyPreferences);

export default router;