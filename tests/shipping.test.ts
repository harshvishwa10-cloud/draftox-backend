import { describe, expect, it } from 'vitest';
import {
  buildCreateShipmentPayload,
  createShipment,
  getDelhiveryConfig,
  isDelhiveryWaybill,
  parseTrackingResponse,
  publicTrackingUrl,
} from '../src/modules/shipping/delhivery.js';

describe('Delhivery integration preparation', () => {
  it('reports booking as disabled without approved credentials', () => {
    const cfg = getDelhiveryConfig();
    expect(cfg.configured).toBe(false);
    expect(cfg.bookingEnabled).toBe(false);
    // Defaults to the staging environment, never production, until configured.
    expect(cfg.baseUrl).toContain('staging-express.delhivery.com');
  });

  it('refuses to make a live booking (503, no network call)', async () => {
    await expect(
      createShipment({
        referenceId: 'ord_1',
        declaredValue: 7999,
        paymentMode: 'Prepaid',
        consignee: {
          name: 'A',
          phone: '9999999999',
          address: '1 Main Street',
          city: 'Mumbai',
          state: 'Maharashtra',
          pincode: '400001',
        },
      }),
    ).rejects.toMatchObject({ statusCode: 503 });
  });

  it('builds a prepaid single-piece payload and keeps ids separate', () => {
    const payload = buildCreateShipmentPayload({
      referenceId: 'ord_internal_1',
      orderNumber: '10042',
      declaredValue: 7999,
      paymentMode: 'Prepaid',
      consignee: {
        name: 'Aarav Sharma',
        phone: '+919999999999',
        address: '1 MG Road',
        city: 'Pune',
        state: 'Maharashtra',
        pincode: '411001',
        email: 'aarav@example.com',
      },
    });
    const shipment = (payload.shipments as Array<Record<string, unknown>>)[0];
    expect(shipment.payment_mode).toBe('Prepaid');
    expect(shipment.order).toBe('ord_internal_1');
    expect(shipment.order_number).toBe('10042');
    // No waybill is invented client-side.
    expect(shipment).not.toHaveProperty('waybill');
  });

  it('parses a tracking response and validates waybills', () => {
    const parsed = parseTrackingResponse({
      ShipmentData: [{ Shipment: { AWB: 'DLV123456', Status: { Status: 'Delivered', StatusCode: 'DLVD' } } }],
    });
    expect(parsed).toEqual({ waybill: 'DLV123456', status: 'Delivered', statusCode: 'DLVD' });

    expect(isDelhiveryWaybill('DLV-123456')).toBe(true);
    expect(isDelhiveryWaybill('10042')).toBe(false); // too short / not a waybill
    expect(publicTrackingUrl('DLV 123')).toBe('https://www.delhivery.com/track/package/DLV%20123');
  });
});
