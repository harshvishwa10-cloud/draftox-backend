import { afterEach, describe, expect, it } from 'vitest';
import {
  FREE_DELIVERY_THRESHOLD,
  STANDARD_DELIVERY_FEE,
  TEST_PRICE_AMOUNT,
  TEST_PRICE_SLUG,
  deliveryFeeForSubtotal,
  effectiveUnitPrice,
  estimatedDeliveryFrom,
  freeShippingOverrideEnabled,
  orderTotalForSubtotal,
  testPriceOverrideEnabled,
} from '../src/modules/orders/pricing.js';

const ORIGINAL_ENV = { ...process.env };

function restoreEnv(key: string): void {
  if (ORIGINAL_ENV[key] === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = ORIGINAL_ENV[key];
  }
}

afterEach(() => {
  process.env.NODE_ENV = ORIGINAL_ENV.NODE_ENV;
  restoreEnv('DEV_TEST_PRICE_ENABLED');
  restoreEnv('DEV_FREE_SHIPPING_ENABLED');
});

describe('deliveryFeeForSubtotal', () => {
  it('charges the flat fee at or below the threshold (strictly greater is free)', () => {
    expect(deliveryFeeForSubtotal(0)).toBe(STANDARD_DELIVERY_FEE);
    expect(deliveryFeeForSubtotal(7999)).toBe(STANDARD_DELIVERY_FEE);
    expect(deliveryFeeForSubtotal(FREE_DELIVERY_THRESHOLD)).toBe(STANDARD_DELIVERY_FEE);
    expect(deliveryFeeForSubtotal(FREE_DELIVERY_THRESHOLD + 1)).toBe(0);
    expect(deliveryFeeForSubtotal(19999)).toBe(0);
  });
});

describe('orderTotalForSubtotal', () => {
  it('adds the delivery fee below the threshold and nothing above it', () => {
    expect(orderTotalForSubtotal(7999)).toBe(7999 + STANDARD_DELIVERY_FEE);
    expect(orderTotalForSubtotal(11999)).toBe(11999);
    expect(orderTotalForSubtotal(15998)).toBe(15998);
    expect(orderTotalForSubtotal(19999)).toBe(19999);
  });
});

describe('testPriceOverrideEnabled', () => {
  it('is on only when the flag is set and the environment is not production', () => {
    expect(testPriceOverrideEnabled('development', 'true')).toBe(true);
    expect(testPriceOverrideEnabled('test', 'true')).toBe(true);
    expect(testPriceOverrideEnabled('development', 'false')).toBe(false);
    expect(testPriceOverrideEnabled('development', undefined)).toBe(false);
    expect(testPriceOverrideEnabled('production', 'true')).toBe(false);
  });
});

describe('freeShippingOverrideEnabled', () => {
  it('is on only when the flag is set and the environment is not production', () => {
    expect(freeShippingOverrideEnabled('development', 'true')).toBe(true);
    expect(freeShippingOverrideEnabled('test', 'true')).toBe(true);
    expect(freeShippingOverrideEnabled('development', 'false')).toBe(false);
    expect(freeShippingOverrideEnabled('development', undefined)).toBe(false);
    expect(freeShippingOverrideEnabled('production', 'true')).toBe(false);
  });
});

describe('deliveryFeeForSubtotal with the free-shipping override', () => {
  it('zeroes delivery while the override is on, for any subtotal', () => {
    process.env.NODE_ENV = 'test';
    process.env.DEV_FREE_SHIPPING_ENABLED = 'true';
    expect(freeShippingOverrideEnabled()).toBe(true);
    expect(deliveryFeeForSubtotal(0)).toBe(0);
    expect(deliveryFeeForSubtotal(7999)).toBe(0);
    expect(deliveryFeeForSubtotal(FREE_DELIVERY_THRESHOLD)).toBe(0);
    expect(orderTotalForSubtotal(10)).toBe(10);
  });

  it('keeps the ₹110 / threshold rule while the override is off', () => {
    process.env.NODE_ENV = 'test';
    process.env.DEV_FREE_SHIPPING_ENABLED = 'false';
    expect(deliveryFeeForSubtotal(7999)).toBe(STANDARD_DELIVERY_FEE);
    expect(deliveryFeeForSubtotal(FREE_DELIVERY_THRESHOLD + 1)).toBe(0);
  });

  it('never zeroes delivery in production even with the flag set', () => {
    process.env.NODE_ENV = 'production';
    process.env.DEV_FREE_SHIPPING_ENABLED = 'true';
    expect(freeShippingOverrideEnabled()).toBe(false);
    expect(deliveryFeeForSubtotal(7999)).toBe(STANDARD_DELIVERY_FEE);
  });
});

describe('effectiveUnitPrice', () => {
  it('returns the catalogue price when the override is disabled', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.DEV_TEST_PRICE_ENABLED;
    expect(effectiveUnitPrice(TEST_PRICE_SLUG, 7999)).toBe(7999);
    expect(effectiveUnitPrice('draftox-24-channel', 11999)).toBe(11999);
  });

  it('applies the token price to the 16-channel system only, when enabled', () => {
    process.env.NODE_ENV = 'test';
    process.env.DEV_TEST_PRICE_ENABLED = 'true';
    expect(effectiveUnitPrice(TEST_PRICE_SLUG, 7999)).toBe(TEST_PRICE_AMOUNT);
    expect(effectiveUnitPrice('draftox-24-channel', 11999)).toBe(11999);
    expect(effectiveUnitPrice('draftox-40-channel', 19999)).toBe(19999);
  });

  it('never applies the override in production even with the flag set', () => {
    process.env.NODE_ENV = 'production';
    process.env.DEV_TEST_PRICE_ENABLED = 'true';
    expect(effectiveUnitPrice(TEST_PRICE_SLUG, 7999)).toBe(7999);
  });
});

describe('estimatedDeliveryFrom', () => {
  it('adds the fixed calendar-day window to the persisted timestamp', () => {
    const created = new Date('2026-01-01T00:00:00.000Z');
    const estimate = estimatedDeliveryFrom(created);
    expect(estimate.getTime() - created.getTime()).toBe(15 * 24 * 60 * 60 * 1000);
  });
});
