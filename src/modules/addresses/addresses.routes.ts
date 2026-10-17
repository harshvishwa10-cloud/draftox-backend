import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { createAddress, deleteAddress, listAddresses, updateAddress } from './addresses.controller.js';

const router = Router();

router.use(requireAuth);
// The global generalLimiter (mounted in app.ts) already rate-limits these
// routes; a second generalLimiter here would double-count each request and
// halve the effective limit.
router.get('/', listAddresses);
router.post('/', createAddress);
router.put('/:id', updateAddress);
router.delete('/:id', deleteAddress);

export default router;
