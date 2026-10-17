import { Router } from 'express';
import { health } from './health.controller.js';

const router = Router();

router.get('/', health);

export default router;
