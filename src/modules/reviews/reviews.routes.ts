import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { createReview, listMyReviews } from './reviews.controller.js';

const router = Router();

// Reviews are tied to the customer's own order — always require sign-in.
router.use(requireAuth);

router.post('/', createReview);
router.get('/', listMyReviews);

export default router;
