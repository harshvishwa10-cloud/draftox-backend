/**
 * Delhivery courier integration — PREPARATION ONLY.
 *
 * No live booking, wallet recharge, or production call is made from this build.
 * This module provides:
 *   - configuration read from environment placeholders (no secrets in code),
 *   - pure helpers to build/parse the Delhivery request/response shapes, and
 *   - guarded entry points that refuse to run until an operator explicitly
 *     enables booking AND provides approved credentials.
 *
 * Official requirements (as of this writing) — see API.md for the checklist:
 *   - A registered Delhivery business account that has completed KYC/onboarding.
 *   - An API token, issued per environment: staging (Test) and production.
 *     Tokens are environment-specific and obtained from the Delhivery One
 *     dashboard (Settings > API Setup) or the onboarding team (de.onb@delhivery.com).
 *   - A registered client pickup warehouse/location name.
 *   - Base URLs: staging https://staging-express.delhivery.com,
 *     production https://track.delhivery.com.
 *   - Auth header form: `Authorization: Token <API_TOKEN>`.
 *   Endpoints (informational): create shipment POST /api/cmu/create.json
 *   (body `format=json&data=<json>`); tracking GET
 *   /api/v1/packages/json/?waybill=<awb>&ref_ids=<ref>.
 */
import { delhiveryConfigured, env } from '../../config/env.js';
import { ApiError } from '../../utils/ApiError.js';

const STAGING_BASE = 'https://staging-express.delhivery.com';
const PRODUCTION_BASE = 'https://track.delhivery.com';

/** Public Delhivery tracking page for a waybill (safe to display, no API call). */
export function publicTrackingUrl(waybill: string): string {
  return `https://www.delhivery.com/track/package/${encodeURIComponent(waybill)}`;
}

/** Loose sanity check for a courier AWB/waybill (never the DRAFTOX number). */
export function isDelhiveryWaybill(value: unknown): boolean {
  return typeof value === 'string' && /^[A-Za-z0-9-]{6,40}$/.test(value.trim());
}

export interface DelhiveryConfig {
  mode: 'staging' | 'production';
  baseUrl: string;
  pickupLocation: string | null;
  hasToken: boolean;
  bookingEnabled: boolean;
  configured: boolean;
}

export function getDelhiveryConfig(): DelhiveryConfig {
  const mode = env.DELHIVERY_MODE;
  return {
    mode,
    baseUrl:
      env.DELHIVERY_BASE_URL ?? (mode === 'production' ? PRODUCTION_BASE : STAGING_BASE),
    pickupLocation: env.DELHIVERY_PICKUP_LOCATION ?? null,
    hasToken: Boolean(env.DELHIVERY_API_TOKEN),
    // Live booking requires BOTH credentials and an explicit opt-in flag.
    bookingEnabled: delhiveryConfigured && env.DELHIVERY_ENABLE_BOOKING === 'true',
    configured: delhiveryConfigured,
  };
}

export interface DelhiveryShipmentInput {
  /** Internal reference (order id). Kept separate from the DRAFTOX number. */
  referenceId: string;
  /** DRAFTOX customer-facing 5-digit number, carried as a human reference only. */
  orderNumber?: string | null;
  declaredValue: number;
  paymentMode: 'Prepaid';
  consignee: {
    name: string;
    phone: string;
    address: string;
    city: string;
    state: string;
    pincode: string;
    email?: string | null;
  };
  weightGrams?: number;
}

/**
 * Builds the JSON `data` document for a Delhivery create-shipment request.
 * Pure and side-effect free, so it can be unit tested without network access.
 */
export function buildCreateShipmentPayload(input: DelhiveryShipmentInput): Record<string, unknown> {
  const cfg = getDelhiveryConfig();
  return {
    shipments: [
      {
        // For single-piece shipments the waybill is assigned by Delhivery.
        name: input.consignee.name,
        add: input.consignee.address,
        city: input.consignee.city,
        state: input.consignee.state,
        pin: input.consignee.pincode,
        phone: input.consignee.phone,
        ...(input.consignee.email ? { email: input.consignee.email } : {}),
        order: input.referenceId,
        ...(input.orderNumber ? { order_number: input.orderNumber } : {}),
        payment_mode: input.paymentMode,
        cod_amount: 0,
        declared_value: input.declaredValue,
        weight: input.weightGrams ?? 1000,
        products_desc: 'DRAFTOX relay automation system',
        quantity: 1,
      },
    ],
    pickup_location: { name: cfg.pickupLocation ?? '' },
  };
}

/** Normalises a Delhivery tracking payload into the fields we care about. */
export function parseTrackingResponse(payload: unknown): {
  waybill: string | null;
  status: string | null;
  statusCode: string | null;
} {
  const root = payload as { ShipmentData?: Array<{ Shipment?: Record<string, unknown> }> } | null;
  const shipment = root?.ShipmentData?.[0]?.Shipment ?? undefined;
  const statusObj = shipment?.Status as { Status?: string; StatusCode?: string } | undefined;
  return {
    waybill: (shipment?.AWB as string | undefined) ?? null,
    status: statusObj?.Status ?? null,
    statusCode: statusObj?.StatusCode ?? null,
  };
}

/**
 * Live booking is intentionally NOT implemented in this build. It refuses until
 * credentials + explicit opt-in exist, and even then must be implemented and
 * approved before use. Never call production endpoints from here today.
 */
export async function createShipment(_input: DelhiveryShipmentInput): Promise<never> {
  const cfg = getDelhiveryConfig();
  if (!cfg.configured) {
    throw ApiError.serviceUnavailable(
      'Delhivery is not configured. Record courier + tracking details manually until approved API credentials are provided.',
    );
  }
  throw ApiError.serviceUnavailable(
    'Delhivery booking is not enabled in this build. No live booking was made.',
  );
}
