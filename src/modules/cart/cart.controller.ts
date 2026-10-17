import type { Request, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { cartSetSchema } from '../../schemas/cart.schema.js';

const productSelect = {
  slug: true,
  name: true,
  price: true,
  mrp: true,
  currency: true,
  image: true,
  availability: true,
} as const;

/**
 * Builds the response for a user's cart. Prices are always read from the
 * current PUBLISHED Product rows — never from the request or stored values.
 */
async function serializeCart(userId: string) {
  const rows = await prisma.cartItem.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
    include: { product: { select: productSelect } },
  });

  // Only items whose product is still published are returned to the client.
  const items = rows
    .filter((row) => row.product.price !== null)
    .map((row) => ({
      slug: row.slug,
      qty: row.qty,
      product: {
        slug: row.product.slug,
        name: row.product.name,
        price: row.product.price,
        mrp: row.product.mrp,
        currency: row.product.currency,
        image: row.product.image,
        availability: row.product.availability,
      },
    }));

  const subtotal =
    Math.round(
      items.reduce((sum, item) => sum + Number(item.product.price) * item.qty, 0) * 100,
    ) / 100;

  return { items, subtotal, currency: 'INR' as const };
}

export const getCart = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  res.status(200).json({ success: true, data: await serializeCart(req.user.id) });
});

/** Replaces the whole server cart atomically. Used for add/remove/setQty/merge. */
export const setCart = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const input = cartSetSchema.parse(req.body);

  // Collapse duplicate slugs, keeping the highest qty (never sum, to stay <= 10).
  const wanted = new Map<string, number>();
  for (const line of input.items) {
    wanted.set(line.slug, Math.max(wanted.get(line.slug) ?? 0, line.qty));
  }

  const slugs = [...wanted.keys()];
  if (slugs.length > 0) {
    const published = await prisma.product.findMany({
      where: { slug: { in: slugs }, status: 'PUBLISHED', price: { not: null } },
      select: { slug: true },
    });
    const available = new Set(published.map((p) => p.slug));
    const missing = slugs.filter((slug) => !available.has(slug));
    if (missing.length > 0) {
      throw ApiError.badRequest('One or more products are unavailable and cannot be saved to your cart');
    }
  }

  await prisma.$transaction([
    prisma.cartItem.deleteMany({ where: { userId: req.user.id } }),
    ...(slugs.length > 0
      ? [
          prisma.cartItem.createMany({
            data: slugs.map((slug) => ({
              userId: req.user!.id,
              slug,
              qty: wanted.get(slug) as number,
            })),
          }),
        ]
      : []),
  ]);

  res.status(200).json({ success: true, data: await serializeCart(req.user.id) });
});

export const removeCartItem = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const slug = String(req.params.slug ?? '');
  await prisma.cartItem.deleteMany({ where: { userId: req.user.id, slug } });
  res.status(200).json({ success: true, data: await serializeCart(req.user.id) });
});

export const clearCart = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  await prisma.cartItem.deleteMany({ where: { userId: req.user.id } });
  res.status(200).json({ success: true, data: { items: [], subtotal: 0, currency: 'INR' } });
});
