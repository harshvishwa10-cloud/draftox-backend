import type { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { cacheGet, cacheSet } from '../../lib/cache.js';
import { getValidatedQuery } from '../../middleware/validate.js';
import { productListQuerySchema, type ProductListQuery } from '../../schemas/product.schema.js';
import { effectiveUnitPrice, testPriceOverrideEnabled } from '../orders/pricing.js';

// Public serializer — never includes internalNotes or unpublished fields.
const publicProductSelect = {
  id: true,
  slug: true,
  name: true,
  description: true,
  status: true,
  price: true,
  mrp: true,
  currency: true,
  image: true,
  availability: true,
  specifications: true,
  features: true,
  warrantyMonths: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ProductSelect;

type SerializableProduct = { slug: string; price: unknown };

/**
 * Applies the local-only test-price override to a serialized product. When the
 * override is disabled this is a no-op (and returns the same reference). It is
 * applied at RESPONSE time (never cached) so toggling the flag is reflected
 * immediately and production can never serve a token price.
 */
function withTestPrice<T extends SerializableProduct>(item: T): T {
  if (!testPriceOverrideEnabled()) return item;
  const price = effectiveUnitPrice(item.slug, Number(item.price));
  if (price === Number(item.price)) return item;
  return { ...item, price } as T;
}

export const listProducts = asyncHandler(async (req: Request, res: Response) => {
  const query = getValidatedQuery<ProductListQuery>(req);
  const { page, limit, search } = query;
  const skip = (page - 1) * limit;

  // Public, read-heavy endpoint: serve from Redis when available. Search terms
  // are part of the key, so different searches never cross-contaminate. The
  // cached envelope matches exactly what the client expects. On any cache
  // miss/unavailability we fall through to PostgreSQL.
  const cacheKey = `products:list:${page}:${limit}:${search ?? ''}`;
  const cached = await cacheGet<{ items: SerializableProduct[]; meta: unknown }>(cacheKey);
  if (cached) {
    res.status(200).json({
      success: true,
      data: { ...cached, items: cached.items.map(withTestPrice) },
    });
    return;
  }

  const where: Prisma.ProductWhereInput = {
    status: 'PUBLISHED',
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { description: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [total, items] = await Promise.all([
    prisma.product.count({ where }),
    prisma.product.findMany({
      where,
      select: publicProductSelect,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
  ]);

  const data = {
    items,
    meta: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
  };

  await cacheSet(cacheKey, data);

  res.status(200).json({
    success: true,
    data: { ...data, items: items.map(withTestPrice) },
  });
});

export const getProductBySlug = asyncHandler(async (req: Request, res: Response) => {
  const slug = String(req.params.slug ?? '').trim();
  if (!slug || slug.length > 200) {
    throw ApiError.notFound('Product not found');
  }

  const cacheKey = `products:slug:${slug}`;
  const cached = await cacheGet<{ product: SerializableProduct }>(cacheKey);
  if (cached) {
    res.status(200).json({
      success: true,
      data: { product: withTestPrice(cached.product) },
    });
    return;
  }

  const product = await prisma.product.findFirst({
    where: { slug, status: 'PUBLISHED' },
    select: publicProductSelect,
  });

  if (!product) {
    throw ApiError.notFound('Product not found');
  }

  await cacheSet(cacheKey, { product });

  res.status(200).json({
    success: true,
    data: { product: withTestPrice(product) },
  });
});

export { productListQuerySchema };
