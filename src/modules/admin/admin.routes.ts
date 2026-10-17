import { Router } from 'express';
import { requireAdmin, requireAuth } from '../../middleware/auth.js';
import {
  getAdminOrder,
  listAdminOrders,
  retryRefund,
  retryOrderEmail,
  retryShipmentNotification,
  sendShipmentUpdateEmail,
  updateOrderFulfillment,
  upsertOrderShipment,
} from './admin.controller.js';
import {
  getPaymentAuditSummary,
  listAdminRefunds,
  listPaymentExceptions,
  reconcileOrder,
  resolvePaymentException,
} from './adminPayments.controller.js';
import {
  decideAdminReturn,
  getAdminReturn,
  getAdminReturnPhoto,
  listAdminReturns,
} from '../returns/adminReturns.controller.js';
import {
  listAdminContactInquiries,
  listAdminProductInquiries,
  listAdminSupportRequests,
  retryInquiryNotification,
  updateContactInquiryStatus,
  updateProductInquiryStatus,
  updateSupportRequestStatus,
} from './adminInquiries.controller.js';

const router = Router();

// Every admin route is gated server-side: authentication first, then the
// ADMIN role. Hiding the page in the frontend is never the security boundary.
router.use(requireAuth, requireAdmin);

router.get('/orders', listAdminOrders);
router.get('/orders/:id', getAdminOrder);
router.patch('/orders/:id/fulfillment', updateOrderFulfillment);
router.patch('/orders/:id/shipment', upsertOrderShipment);

// Notification management (admin-only).
router.post('/notifications/:id/retry', retryShipmentNotification);
router.post('/orders/:id/shipment/email', sendShipmentUpdateEmail);

// Refund + order-notification management (admin-only).
router.post('/refunds/:id/retry', retryRefund);
router.post('/order-notifications/:id/retry', retryOrderEmail);

// Payment recovery: exception queue, audit summary and on-demand reconciliation.
router.get('/payment-exceptions', listPaymentExceptions);
router.patch('/payment-exceptions/:id', resolvePaymentException);
router.get('/payments/summary', getPaymentAuditSummary);
router.get('/refunds', listAdminRefunds);
router.post('/orders/:id/reconcile-payment', reconcileOrder);

// Return requests (admin-only). Photo routes must be declared after
// '/returns/:id' is NOT an issue since ':id' is a single segment.
router.get('/returns', listAdminReturns);
router.get('/returns/:id', getAdminReturn);
router.get('/returns/:id/photos/:photoId', getAdminReturnPhoto);
router.patch('/returns/:id', decideAdminReturn);

// Public-request inbox (contact enquiries, product enquiries, support requests).
router.get('/inquiries/contact', listAdminContactInquiries);
router.patch('/inquiries/contact/:id', updateContactInquiryStatus);
router.get('/inquiries/product', listAdminProductInquiries);
router.patch('/inquiries/product/:id', updateProductInquiryStatus);
router.get('/inquiries/support', listAdminSupportRequests);
router.patch('/inquiries/support/:id', updateSupportRequestStatus);

// Owner-notification retry for a public request.
router.post('/inquiry-notifications/:id/retry', retryInquiryNotification);

export default router;
