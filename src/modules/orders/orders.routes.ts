import { Router } from 'express';
import { optionalAuth, requireAuth } from '../../middleware/auth.js';
import { inquiryLimiter } from '../../middleware/rateLimit.js';
import {
  cancelOrderById,
  cancelOrderByNumber,
  createOrder,
  getOrder,
  getOrderByNumber,
  listOrders,
} from './orders.controller.js';

const router = Router();

router.post('/', inquiryLimiter, optionalAuth, createOrder);
router.get('/', requireAuth, listOrders);
// Must be declared before '/:id' so the literal prefix is not captured as an id.
router.get('/by-number/:orderNumber', requireAuth, getOrderByNumber);
router.post('/by-number/:orderNumber/cancel', inquiryLimiter, requireAuth, cancelOrderByNumber);
router.post('/:id/cancel', inquiryLimiter, requireAuth, cancelOrderById);
router.get('/:id', requireAuth, getOrder);

export default router;
