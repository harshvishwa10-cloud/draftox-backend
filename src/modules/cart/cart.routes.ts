import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { clearCart, getCart, removeCartItem, setCart } from './cart.controller.js';

const router = Router();

router.use(requireAuth);
// The global generalLimiter (mounted in app.ts) already rate-limits these
// routes; a second generalLimiter here would double-count each request and
// halve the effective limit.
router.get('/', getCart);
router.put('/', setCart);
router.delete('/', clearCart);
router.delete('/:slug', removeCartItem);

export default router;
