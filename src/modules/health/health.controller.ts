import type { Request, Response } from 'express';
import { probeCache } from '../../lib/cache.js';
import { prisma } from '../../lib/prisma.js';

const startedAt = Date.now();

export async function health(_req: Request, res: Response): Promise<void> {
  let database: 'connected' | 'error' = 'connected';
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    database = 'error';
  }

  // Actively PING Redis (bounded) so the reported status reflects REAL
  // reachability. Reading lazy client state alone mis-reports a healthy but
  // idle Redis as `unavailable` until the first catalogue read. The probe never
  // throws and its error is credential-free. Purely informational — it does NOT
  // affect the status code, which stays driven by database connectivity alone.
  const cache = await probeCache();

  res.status(database === 'connected' ? 200 : 503).json({
    success: true,
    data: {
      status: database === 'connected' ? 'ok' : 'degraded',
      database,
      cache: cache.status,
      cacheError: cache.error,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      timestamp: new Date().toISOString(),
    },
  });
}
