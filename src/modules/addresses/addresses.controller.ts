import type { Request, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { addressSchema } from '../../schemas/address.schema.js';

const addressSelect = {
  id: true,
  label: true,
  line: true,
  city: true,
  state: true,
  pincode: true,
  createdAt: true,
} as const;

export const listAddresses = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const addresses = await prisma.address.findMany({
    where: { userId: req.user.id },
    select: addressSelect,
    orderBy: { createdAt: 'desc' },
  });
  res.status(200).json({ success: true, data: { addresses } });
});

export const createAddress = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const input = addressSchema.parse(req.body);
  const count = await prisma.address.count({ where: { userId: req.user.id } });
  if (count >= 10) {
    throw ApiError.badRequest('Address limit reached (10). Delete one before adding another.');
  }
  const address = await prisma.address.create({
    data: { userId: req.user.id, ...input },
    select: addressSelect,
  });
  res.status(201).json({ success: true, data: { address } });
});

export const updateAddress = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const id = String(req.params.id ?? '');
  const input = addressSchema.parse(req.body);
  const existing = await prisma.address.findFirst({ where: { id, userId: req.user.id } });
  if (!existing) throw ApiError.notFound('Address not found');
  const address = await prisma.address.update({
    where: { id },
    data: input,
    select: addressSelect,
  });
  res.status(200).json({ success: true, data: { address } });
});

export const deleteAddress = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const id = String(req.params.id ?? '');
  const existing = await prisma.address.findFirst({ where: { id, userId: req.user.id } });
  if (!existing) throw ApiError.notFound('Address not found');
  await prisma.address.delete({ where: { id } });
  res.status(200).json({ success: true, data: { message: 'Address deleted' } });
});
