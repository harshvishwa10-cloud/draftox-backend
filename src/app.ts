import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { corsOrigins } from './config/env.js';
import { csrfProtection, ensureCsrfCookieMiddleware } from './middleware/csrf.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { generalLimiter } from './middleware/rateLimit.js';
import authRoutes from './modules/auth/auth.routes.js';
import contactRoutes from './modules/contact/contact.routes.js';
import healthRoutes from './modules/health/health.routes.js';
import productInquiryRoutes from './modules/productInquiries/productInquiry.routes.js';
import productsRoutes from './modules/products/products.routes.js';
import supportRoutes from './modules/support/support.routes.js';
import ordersRoutes from './modules/orders/orders.routes.js';
import returnsRoutes from './modules/returns/returns.routes.js';
import addressesRoutes from './modules/addresses/addresses.routes.js';
import cartRoutes from './modules/cart/cart.routes.js';
import paymentsRoutes from './modules/payments/payments.routes.js';
import adminRoutes from './modules/admin/admin.routes.js';
import trackingRoutes from './modules/tracking/tracking.routes.js';
import privacyRoutes from './modules/privacy/privacy.routes.js';
import reviewsRoutes from './modules/reviews/reviews.routes.js';
import { razorpayWebhook } from './modules/payments/payments.controller.js';

export function createApp() {
  const app = express();

  // We sit behind a reverse proxy in production; trust the first hop for req.ip / X-Forwarded-For
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      // The API is consumed by a separate frontend origin; relax COEP/CORP accordingly.
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  app.use(
    cors({
      origin(origin, callback) {
        // Allow same-origin / curl / server-to-server requests (no Origin header).
        if (!origin) {
          callback(null, true);
          return;
        }
        if (corsOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(null, false);
      },
      credentials: true,
       methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'Accept'],
      maxAge: 600,
    }),
  );

  // Razorpay webhook: raw body + its own HMAC check. Must be mounted before the
  // JSON body parser (which would consume the stream) and before CSRF, since
  // Razorpay posts server-to-server with no cookies.
  app.use(
    '/api/v1/payments/razorpay/webhook',
    express.raw({ type: 'application/json', limit: '100kb' }),
    razorpayWebhook,
  );

  // Return submissions carry client-side photos (base64, up to 5 × ~3 MB). The
  // scoped larger body parser must run BEFORE the global 100kb parser so that
  // parser short-circuits on req._body and never collapses the payload size.
  app.use('/api/v1/orders/:orderId/returns', express.json({ limit: '10mb' }));

  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  app.use(generalLimiter);
  app.use(ensureCsrfCookieMiddleware);

  // CSRF protection applies to all state-changing API routes (GET is exempt).
  app.use('/api/v1', csrfProtection);

  app.use('/api/v1/health', healthRoutes);
  app.use('/api/v1/auth', authRoutes);
  app.use('/api/v1/contact', contactRoutes);
  app.use('/api/v1/product-inquiries', productInquiryRoutes);
  app.use('/api/v1/support', supportRoutes);
  app.use('/api/v1/products', productsRoutes);
  app.use('/api/v1/orders', ordersRoutes);
  app.use('/api/v1/orders', returnsRoutes);
  app.use('/api/v1/addresses', addressesRoutes);
  app.use('/api/v1/cart', cartRoutes);
  app.use('/api/v1/payments', paymentsRoutes);
  app.use('/api/v1/admin', adminRoutes);
  app.use('/api/v1/reviews', reviewsRoutes);

  app.use('/api/v1/privacy', privacyRoutes);

  // Public tracking page — no auth, CSRF GET-exempt, no-index on the page itself.
  app.use('/api/v1/track', trackingRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
