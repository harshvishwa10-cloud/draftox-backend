import { Router } from 'express';
import { validateQuery } from '../../middleware/validate.js';
import { productListQuerySchema } from '../../schemas/product.schema.js';
import { getProductBySlug, listProducts } from './products.controller.js';

const router = Router();

router.get('/', validateQuery(productListQuerySchema), listProducts);
router.get('/:slug', getProductBySlug);

export default router;
