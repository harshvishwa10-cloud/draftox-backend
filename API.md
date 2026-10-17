# DRAFTOX Backend API (v1)

Base URL (development): `http://localhost:4000`
All endpoints are prefixed with `/api/v1`.

## Conventions

- **Content type:** `application/json` (request bodies limited to 100 KB).
- **Success shape:** `{ "success": true, "data": { ... } }`
- **Error shape:**

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [{ "path": "email", "message": "Enter a valid email address" }]
  }
}
```

- **Status codes:** `200` ok · `201` created · `400` bad request · `401` unauthenticated · `403` forbidden/CSRF · `404` not found · `409` conflict · `422` validation · `429` rate limited · `503` dependency unavailable.
- **CSRF:** every response sets a readable `draftox_csrf` cookie. Send it back as header `X-CSRF-Token` on every `POST` (and any non-GET) request. Requests without a matching token get `403`.
- **Auth:** session cookie `draftox_session` (HttpOnly, SameSite=Lax, Secure in production). Send fetches with `credentials: 'include'`.

---

## Health

### `GET /api/v1/health`

Auth: none.

```json
{
  "success": true,
  "data": {
    "status": "ok",
    "database": "connected",
    "uptimeSeconds": 12,
    "timestamp": "2026-10-10T16:39:24.146Z"
  }
}
```

Returns `503` with `status: "degraded"` when the database is unreachable.

---

## Authentication

Rate limited: 20 requests / 15 min / IP (configurable via `AUTH_RATE_LIMIT_*`).

### `POST /api/v1/auth/register`

Auth: none (must not be signed in is not required — a valid CSRF token is).

Request:

```json
{ "name": "Aarav Shah", "email": "aarav@example.com", "password": "supersecret1" }
```

`201`:

```json
{
  "success": true,
  "data": {
    "user": {
      "id": "cmv...",
      "name": "Aarav Shah",
      "email": "aarav@example.com",
      "role": "CUSTOMER",
      "createdAt": "2026-10-10T16:00:00.000Z"
    }
  }
}
```

Sets the session cookie. `409` if the email already exists; `422` on invalid input (unknown fields such as `role` are rejected).

### `POST /api/v1/auth/login`

Request:

```json
{ "email": "aarav@example.com", "password": "supersecret1" }
```

`200` with `data.user` (same shape as register) + session cookie.
`401` with generic message `"Invalid email or password"` for wrong email **or** wrong password (including Google-only accounts).

### `POST /api/v1/auth/logout`

Requires session cookie (works even if expired). Invalidates the server-side session and clears the cookie.

`200`: `{ "success": true, "data": { "message": "Signed out" } }`

### `GET /api/v1/auth/me`

Requires session. `200` with `data.user`, or `401` if missing/expired (expired sessions are deleted and the cookie cleared).

### `POST /api/v1/auth/forgot-password`

Request: `{ "email": "aarav@example.com" }`

`200` (always for unknown emails — no account enumeration):

```json
{
  "success": true,
  "data": {
    "message": "If an account exists for that email, a password reset link has been issued."
  }
}
```

Development with `EMAIL_PROVIDER=none` and a known email — **no email is sent**, and the response is honest about it:

```json
{
  "success": true,
  "data": {
    "message": "Development mode: email delivery is not configured, so no email was sent. The reset token is returned below for local testing only.",
    "devToken": "hQ3..."
  }
}
```

Production without email delivery: `503`. Tokens are stored as SHA-256 hashes, expire in 1 hour, and are single-use.

With `EMAIL_PROVIDER=smtp` configured, the reset link is emailed to the account (`<PUBLIC_SITE_URL>/reset-password?token=...`) and the response is always the generic `200` message above — the token is never returned in the response. If the mail provider rejects the send it is logged server-side and the caller still receives the generic `200` (no enumeration, no delivery leakage).

### `POST /api/v1/auth/reset-password`

Request:

```json
{ "token": "hQ3...", "password": "newpassword123" }
```

`200` on success. Invalidates the token (single-use) and **all active sessions** for that user. `400` for invalid/expired/reused tokens.

### `GET /api/v1/auth/google`

Requires Google OAuth env vars. Redirects the browser to Google's consent screen (scopes: `openid email profile`, state parameter stored in a short-lived HttpOnly cookie).

### `GET /api/v1/auth/google/callback`

Google redirects here with `code` + `state`. On success: session cookie set, browser redirected to `{FRONTEND_URL}/auth/callback?status=success&next=<path>`, where `next` is `/admin/orders` for the administrator and `/account` for everyone else. On failure: `?status=error&reason=invalid_state|missing_code|forbidden|oauth_failed`.

Only Google-verified emails are accepted. Accounts are matched by Google subject ID, then linked by verified email, otherwise created (password hash `null`). Google tokens are never persisted.

**Single administrator.** Exactly one account can ever be an administrator: the
email in `ADMIN_EMAIL` (default `draftox0@gmail.com`) **and** only when that
identity arrives through Google with `email_verified: true`. Authorization is
derived from this server-side policy on every request — a row in the database
whose `role` is `ADMIN` but whose email is anything else is **denied** (and the
API reports its effective role as `CUSTOMER`). Password/email sign-in can never
grant admin. The migration that introduces this policy also demotes any
pre-existing non-authorized `ADMIN` rows to `CUSTOMER`; customer orders,
addresses and account data are untouched.

### `GET /api/v1/auth/providers`

Auth: none. Reports which third-party sign-in providers are configured, so the
frontend can show an honest pending state instead of a dead button.

`200`: `{ "success": true, "data": { "google": false } }` (until `GOOGLE_CLIENT_ID` is set).

Google Cloud Console setup (https://console.cloud.google.com/apis/credentials):

1. Create an **OAuth client ID** of type **Web application**.
2. Add the exact `GOOGLE_CALLBACK_URL` value (e.g.
   `http://localhost:4000/api/v1/auth/google/callback` for local dev) as an
   **Authorized redirect URI** — it must match character-for-character.
3. Put the issued client ID + secret into the backend `.env` and restart.
4. Verify: `GET /api/v1/auth/providers` returns `{ "google": true }`, then
   complete a real Google sign-in and confirm `GET /api/v1/auth/me` returns the
   user. Until that end-to-end test passes, Google sign-in is **not operational**.

---

## Contact

Rate limited: 10 requests / hour / IP (`INQUIRY_RATE_LIMIT_*`).

### `POST /api/v1/contact`

Auth: none (CSRF required). Creates a **contact/project inquiry** — status is always server-set `NEW`; clients cannot set status.

Request:

```json
{
  "name": "Priya Patel",
  "email": "priya@example.com",
  "businessName": "Acme Studio",
  "service": "WEBSITE_DEVELOPMENT",
  "budgetRange": "FROM_25000_TO_50000",
  "message": "We need a marketing website with a CMS."
}
```

- `service`: `WEBSITE_DEVELOPMENT` | `LOGO_BRAND_IDENTITY` | `DIGITAL_PRODUCT` | `HOME_AUTOMATION` | `OTHER`
- `budgetRange` (optional): `NOT_SURE` | `UNDER_10000` | `FROM_10000_TO_25000` | `FROM_25000_TO_50000` | `FROM_50000_TO_100000` | `ABOVE_100000`
- `businessName` optional; message 10–5000 chars.

`201`:

```json
{
  "success": true,
  "data": {
    "inquiry": { "id": "cmv...", "status": "NEW", "createdAt": "2026-10-10T16:00:00.000Z" },
    "message": "Thank you! Your inquiry has been received and our team will get back to you."
  }
}
```

WhatsApp “orders” opened by the visitor are **not** recorded anywhere; only intentional form submissions create records here, and they are inquiries — not confirmed orders.

---

## Product inquiries (purchase intent)

Rate limited: 10 requests / hour / IP.

### `POST /api/v1/product-inquiries`

Auth: optional (signed-in users get their `userId` attached). CSRF required. The product must exist **and be published**.

Request:

```json
{
  "productId": "cmv...",
  "customerName": "Rohan Mehta",
  "email": "rohan@example.com",
  "phone": "+91 98765 43210",
  "quantity": 2,
  "type": "PURCHASE_INTENT",
  "message": "Is the Home Automation kit available? Please share pricing."
}
```

- `type` (default `PURCHASE_INTENT`): `PURCHASE_INTENT` | `QUESTION` | `DEMO_REQUEST` | `CUSTOM_ORDER` | `OTHER`
- `quantity` (optional): 1–1000. `phone` optional.

`201`:

```json
{
  "success": true,
  "data": {
    "inquiry": {
      "id": "cmv...",
      "status": "NEW",
      "type": "PURCHASE_INTENT",
      "quantity": 2,
      "createdAt": "2026-10-10T16:00:00.000Z",
      "product": { "id": "cmv...", "name": "DRAFTox Home Automation", "slug": "draftox-home-automation" }
    },
    "message": "Inquiry received. This is not a confirmed order — our team will contact you to confirm availability, pricing and next steps."
  }
}
```

`404` if the product is unknown or not published. No payment is taken; nothing is marked paid or confirmed.

---

## Support

Rate limited: 10 requests / hour / IP.

### `POST /api/v1/support`

Auth: optional. CSRF required.

Request:

```json
{
  "name": "Sana Khan",
  "contact": "sana@example.com",
  "subject": "Logo revision question",
  "message": "Can we revise the logo concepts from last week?"
}
```

`contact` accepts an email **or** a phone number. `201` with `data.request { id, subject, status: "NEW", createdAt }`.

---

## Products (public)

### `GET /api/v1/products`

Auth: none. Only `PUBLISHED` products are returned. Never includes `internalNotes` or unpublished data.

Query: `page` (1–1000, default 1) · `limit` (1–50, default 12) · `search` (2–100 chars, matches name/description).

`200`:

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "cmv...",
        "slug": "draftox-16-channel",
        "name": "DRAFTOX 16-Channel Relay System",
        "description": "...",
        "status": "PUBLISHED",
        "price": "7999",
        "mrp": "13500",
        "currency": "INR",
        "image": "/images/products/draftox-16-channel.jpg",
        "availability": "PREORDER",
        "specifications": { "platform": "ESP32" },
        "features": ["App control"],
        "createdAt": "2026-10-01T00:00:00.000Z",
        "updatedAt": "2026-10-01T00:00:00.000Z"
      }
    ],
    "meta": { "page": 1, "limit": 12, "total": 3, "totalPages": 1 }
  }
}
```

`price` may be `null` (not yet confirmed) — render “Contact for pricing”. `mrp` may be `null` (no reference price) — render no strikethrough. The catalog currently holds exactly 3 products (`draftox-16-channel`, `draftox-24-channel`, `draftox-40-channel`).

### `GET /api/v1/products/:slug`

Same public fields. `404` if the slug is unknown **or** the product is not published (drafts such as `draftox-home-automation` return 404 until published).

---

## Orders (order requests — never sales on their own)

Rate limited: 10 requests / hour / IP (shared inquiry limiter).

An order created here has status `REQUESTED`. It becomes a real sale only after
the team confirms configuration, installation and payment out-of-band. Unit
prices and totals are **always recomputed server-side from `PUBLISHED` product
rows** — client-supplied totals are ignored (there is no client total field).

### `POST /api/v1/orders`

Auth: optional (signed-in orders attach to the user; guests allowed). CSRF required.

Request:

```json
{
  "items": [{ "productId": "cmv...", "qty": 2 }],
  "name": "Aarav Sharma",
  "email": "aarav@example.com",
  "phone": "+919999999999",
  "address": { "line": "1 MG Road", "city": "Pune", "state": "Maharashtra", "pincode": "411001" }
}
```

`qty` 1–10 per line, max 20 lines. `phone`/`address` optional; pincode must be 6
digits. Unknown product ids → `404`; unpublished products cannot be ordered.

Every order is assigned a **customer-facing 5-digit `orderNumber`** (range
`10000`–`99999`, stored as text) from a single database counter, allocated
atomically **inside the same transaction** that inserts the order. Concurrent
checkouts therefore never share a number, and a rolled-back order releases its
number. The number is server-generated only — it is never derived from the
cuid/timestamp/user or the Razorpay id. If the 90,000-number space is exhausted,
creation fails with `503 ORDER_NUMBER_EXHAUSTED` rather than duplicating.

Each line item is stored as an **immutable snapshot** (`productId, slug, name,
qty, unitPrice, lineTotal, image`) so historical orders keep the name, price and
image even after the catalog changes.

`201` with `data.order { id, orderNumber, items [{ productId, slug, name, qty,
unitPrice, lineTotal, image }], subtotal, amount, currency: "INR", status:
"REQUESTED", paymentMethod: null, ... }` plus an explicit
not-confirmed-not-paid message.

### `GET /api/v1/orders`

Auth: required. Returns the caller's own orders, newest first, paginated.
Query: `limit` (default 20, max 50) and `cursor` (an order `id` from the previous
page). `200` with `data { orders, nextCursor }` where `nextCursor` is the id to
pass as `cursor` for the next page, or `null` when there are no more.

### `GET /api/v1/orders/:id`

Auth: required. Returns the caller's own order or `404`, `data.order`.

### `GET /api/v1/orders/by-number/:orderNumber`

Auth: required. Returns the caller's own order looked up by its 5-digit
`orderNumber`. A malformed number, an unknown number, and **another customer's**
number all return the same `404` — no order existence or detail is ever leaked.
`200` with `data.order`.

---

## Addresses (signed-in users)

General rate limit applies. Max 10 addresses per user.

### `GET /api/v1/addresses`

Auth: required. `200` with `data.addresses [{ id, label, line, city, state, pincode, createdAt }]`.

### `POST /api/v1/addresses`

Auth: required. CSRF required. `label` free text (1–60 chars); pincode 6 digits.
`201` with `data.address`. Over the 10-address cap → `400`.

### `DELETE /api/v1/addresses/:id`

Auth: required. CSRF required. Only the owner's address can be deleted; otherwise
`404`. `200` with `data.message`.

---

## Payments (Razorpay — NOT operational without credentials)

`POST /api/v1/payments/razorpay/order` and the webhook return `503
PAYMENT_PROVIDER_NOT_CONFIGURED` until `RAZORPAY_KEY_ID` + `RAZORPAY_KEY_SECRET`
are set (`RAZORPAY_WEBHOOK_SECRET` additionally required for the webhook). The
frontend must call `GET /api/v1/payments/status` first and treat `false` as
integration-pending — never a working pay button.

An order is marked `PAID` in exactly two places, both of which verify a Razorpay
signature and confirm the amount/currency against the server-side order record:
the webhook and `POST /api/v1/payments/razorpay/verify`. The browser callback
alone is never trusted, and the payable amount is always derived from the stored
`Order.amount` (never the request body). Paid transitions are idempotent and the
verified `razorpayPaymentId` is stored under a unique index, so a replayed
webhook/verification can never double-record a payment. Until valid credentials
are configured **and** a real webhook-signed test payment completes end-to-end,
online payment is **not operational**.

### `GET /api/v1/payments/status`

Auth: none. `200`: `{ "success": true, "data": { "razorpay": false, "webhook": false } }`.

### `POST /api/v1/payments/razorpay/order`

Auth: required. CSRF required. Body: `{ "orderId": "cmv..." }`. The caller must
own the order; it must exist with status `REQUESTED`/`CONFIRMED` and amount ≥ ₹1.
`201` with `data { keyId, razorpayOrderId, amount, currency, orderId }` — `keyId`
is the only secret-adjacent value ever sent to the browser (publishable by
design). Retries for the same order **reuse** the existing `razorpayOrderId`
(returns `200`) instead of creating a duplicate provider order. `404` if the
order is not the caller's; `409` if already paid; `400` if cancelled or otherwise
not payable.

### `POST /api/v1/payments/razorpay/verify`

Auth: required. CSRF required. Body:
`{ orderId, razorpayOrderId, razorpayPaymentId, razorpaySignature }` (the values
Razorpay Checkout returns in its `handler`). The endpoint:

1. Confirms the order belongs to the caller and `razorpayOrderId` matches the one
   stored on the order (otherwise `400`).
2. Verifies the `order_id|payment_id` HMAC-SHA256 signature with
   `RAZORPAY_KEY_SECRET` (failure → `400`).
3. Optionally confirms server-to-server via `GET /v1/payments/:id` that the
   payment is `captured`/`authorized` and its amount/currency match the order
   (mismatch → `400`; provider unreachable → `503`, order stays pending).

On success → `200` `data { order, status: "PAID" }`. Repeat calls are idempotent
(`data.alreadyPaid: true`). When the provider reports the instrument, the
verified method (e.g. `upi`, `card`) is stored on the order as `paymentMethod`
and returned with it.

### `POST /api/v1/payments/razorpay/webhook`

Raw-body HMAC-SHA256 verification against `RAZORPAY_WEBHOOK_SECRET`; mounted
before CSRF/JSON parsing so the raw bytes are preserved. Invalid signature →
`400`; unknown order or unknown event → `200` acknowledged without changes.
Handles `payment.captured`, `order.paid` (→ `PAID`) and `payment.failed`
(→ `FAILED`, only from `REQUESTED`/`CONFIRMED`). Amount/currency are checked
against the local order before marking paid; a mismatch is acknowledged with
`data.handled: false, reason: "amount_mismatch"` and never marks paid. Duplicate
and out-of-order deliveries are safe. `200` with `data.received` / `data.handled`.

Razorpay setup:

1. Create an account at https://dashboard.razorpay.com, generate a **Key ID +
   Key Secret** (use Test Mode keys first), and a **Webhook Secret** for the
   webhook URL `https://<api-host>/api/v1/payments/razorpay/webhook`
   (subscribe to `payment.captured`, `payment.failed` and `order.paid`).
2. Set `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` / `RAZORPAY_WEBHOOK_SECRET` in
   the backend `.env` and restart.
3. Verify: `GET /api/v1/payments/status` returns both `true`; file an order,
   create a Razorpay order, complete a **test-mode** payment, and confirm the
   store order flips to `PAID` (via the checkout `handler` verify call and/or the
   webhook). Until then, payments stay **not operational**.

---

## Admin: order management (ADMIN role only)

Every route under `/api/v1/admin/*` runs `requireAuth` then `requireAdmin`
server-side: `401 UNAUTHENTICATED` when signed out, `403 FORBIDDEN` when the user
is not an admin. `PATCH` routes also require the CSRF token and a JSON body. The
frontend only hides the UI — it is never the security boundary.

No admin account is seeded. Promote an existing account against the database
(dev/test or production, deliberately, by an operator):

```sql
UPDATE "User" SET role = 'ADMIN' WHERE email = '<admin-email>';
```

**Payment status vs fulfilment.** `Order.status`
(`REQUESTED`/`CONFIRMED`/`PAID`/`FAILED`/`CANCELLED`) is the payment/lifecycle
status and is what the admin UI shows as "payment status". `Order.fulfillmentStatus`
is the separate shipping workflow below. When a payment is verified the fulfilment
auto-advances `AWAITING_PAYMENT → PROCESSING` once; the two fields are otherwise
independent (cancelling a paid order keeps `status = PAID`).

**Fulfilment state machine (forward-only).** Skips are rejected with `409`:

```
AWAITING_PAYMENT → PROCESSING | CANCELLED
PROCESSING       → READY_TO_SHIP | CANCELLED
READY_TO_SHIP    → SHIPPED | CANCELLED
SHIPPED          → OUT_FOR_DELIVERY | DELIVERED
OUT_FOR_DELIVERY → DELIVERED
DELIVERED        → (terminal)
CANCELLED        → (terminal)
```

Leaving `AWAITING_PAYMENT` requires `status = PAID` (`409` otherwise).

### `GET /api/v1/admin/orders`

Query (all optional): `q` (max 120), `paymentStatus`, `fulfillmentStatus`,
`limit` (1–100, default 20), `cursor` (last order `id` from the previous page).
A purely numeric `q` matches the 5-digit order number; otherwise it matches
customer name/email/phone (case-insensitive). Passing an invalid enum →
`422`. Newest first.

`200`: `{ "success": true, "data": { "orders": [ ... ], "nextCursor": "id" | null } }`.
Each row carries `id`, `orderNumber`, customer `name`/`email`/`phone`, `items`,
`subtotal`, `amount`, `currency`, `status`, `fulfillmentStatus`, `paymentMethod`,
`address`, `shipment`, and timestamps.

### `GET /api/v1/admin/orders/:id`

`200`: `{ "success": true, "data": { "order": {...}, "fulfillment": { "current": "PROCESSING", "allowedTransitions": ["READY_TO_SHIP", "CANCELLED"] } } }`.
The detail order adds `userId`, `razorpayOrderId`, `razorpayPaymentId`, and
`events` (order history, oldest first). `404` for an unknown id.

### `PATCH /api/v1/admin/orders/:id/fulfillment`

Body: `{ "status": "<next status>", "note": "optional ≤500 chars" }`. Validates
the transition (and the paid requirement) and appends an `OrderEvent`
(`FULFILLMENT_CHANGED`, or `ORDER_CANCELLED`) with the acting admin's id + name.
Cancelling an **unpaid** order also sets `status = CANCELLED`; a **paid** order
keeps its verified payment. `409` for an invalid/skipped transition or an unpaid
order moving past `AWAITING_PAYMENT`; `422` for an invalid body.

### `PATCH /api/v1/admin/orders/:id/shipment`

Body: `{ courierName?, trackingNumber?, trackingUrl?, dispatchNotes?, dispatchedAt?, estimatedDeliveryAt? }`.
`trackingUrl` must be a valid URL; dates accept an ISO string, `""` or `null`
(empty → `null`). Upserts the order's single shipment and appends a
`SHIPMENT_UPDATED` event. Requires `status = PAID` and a non-cancelled order
(`409` otherwise). **No courier is booked** — this only records admin-supplied
details.

## Admin: payment recovery (ADMIN role only)

Same guard rules as above (`requireAuth` → `requireAdmin`; `PATCH` requires CSRF).
These endpoints only read and re-drive state the payment provider already owns —
they **never move money and never auto-refund an uncertain payment**. An
on-demand reconciliation marks an order `PAID` **only** on an exact captured
amount+currency match; anything inconclusive stays pending.

Payment provider ids, amounts and reasons appear here because the caller is an
admin; no credentials, tokens or raw provider payloads are ever returned.

### `GET /api/v1/admin/payment-exceptions`

Payments/webhooks that could not be applied automatically. Query (all optional):
`status` (`OPEN` | `RESOLVED` | `ALL`, default `OPEN`), `kind`
(`UNMATCHED_PAYMENT` | `AMOUNT_MISMATCH` | `CURRENCY_MISMATCH` |
`CANCELLED_PAYMENT` | `DUPLICATE_PAYMENT` | `WEBHOOK_FAILED` |
`RECONCILE_FAILED`), `limit` (1–100), `cursor` (last row `id`). Invalid enums →
`422`.

`200`: `{ "data": { "exceptions": [ ... ], "nextCursor": "id" | null, "counts": { "open": n, "resolved": n } } }`.
Each row: `id`, `kind`, `status`, `orderId`, `razorpayOrderId`,
`razorpayPaymentId`, `amount`, `currency`, `reason`, `details`, `createdAt`,
`resolvedAt`, `resolvedBy`, `resolutionNote`. Newest first.

### `PATCH /api/v1/admin/payment-exceptions/:id`

Body: `{ "note"?: "≤500 chars" }`. Marks the exception `RESOLVED`, recording who /
when / the note. **Idempotent**: an already-resolved row returns unchanged with
`alreadyResolved: true`. `200`:
`{ "data": { "exception": {...}, "alreadyResolved"?: true } }`; `404` unknown id.

### `GET /api/v1/admin/payments/summary`

`200`: `{ "data": { "openExceptions": n, "unmatchedPayments": n,
"webhookFailures24h": n, "webhookReceived24h": n, "refundsAtRisk": n,
"refundSlaHours": 24, "pendingOnlineOrders": n, "pendingPaymentMinutes": 15 } }`.

### `POST /api/v1/admin/orders/:id/reconcile-payment`

Re-checks one order against the provider's payment list on demand. `200`:
`{ "data": { "status": "reconciled" | "already_paid" | "pending" | "not_found" |
"no_provider_order" | "not_configured" | "mismatch" | "error", "paymentId"?: "...",
"order"?: {...} } }`. `reconciled` = the order was just marked `PAID`;
`already_paid` = it already was. `not_found`/`pending` change nothing.

### `GET /api/v1/admin/refunds`

Refund obligations, including those past the 24-hour goal. Query (all optional):
`status` (`ALL` | `REQUESTED` | `PROCESSING` | `SUCCESS` | `FAILED` |
`MANUAL_REVIEW`, default `ALL`), `atRisk` (`true` to return only non-`SUCCESS`
refunds older than `refundSlaHours`), `limit` (1–100), `cursor`.

`200`: `{ "data": { "refunds": [ ... ], "nextCursor": "...",
"counts": { "atRisk": n, "pending": n }, "refundSlaHours": 24 } }`. Each row adds
`hoursSinceCreated`, `atRisk`, and a safe `order`
(`{ orderNumber, name, email, status }`). `SUCCESS` means the provider confirmed
the refund; nothing else does.

## Delhivery shipping (preparation only — no live calls)

Delhivery integration is **not implemented** in this build: no order booking,
wallet recharge, or tracking API call is made anywhere. Couriers and tracking
details are recorded manually through the admin shipment endpoint above, and the
customer UI only ever displays what an admin recorded.

Placeholder environment variables (all optional; absent is the expected default):

| Variable | Meaning |
| --- | --- |
| `DELHIVERY_MODE` | `staging` (default) or `production`. |
| `DELHIVERY_API_TOKEN` | API token, issued per environment. |
| `DELHIVERY_BASE_URL` | Overrides the base; defaults to `https://staging-express.delhivery.com` (`https://track.delhivery.com` in production). |
| `DELHIVERY_PICKUP_LOCATION` | Registered pickup warehouse/location name. |
| `DELHIVERY_ENABLE_BOOKING` | `true`/`false` (default `false`). Both this and the credentials are required before booking can run. |

`src/modules/shipping/delhivery.ts` exposes the config, pure request/response
builders (unit-tested without network), and a guarded `createShipment()` that
returns `503 SERVICE_UNAVAILABLE` until booking is actually implemented. To go
live you need, in order:

1. A Delhivery business account that has completed **KYC/onboarding**.
2. An **API token** issued for the target environment (staging vs production).
3. A registered **client pickup warehouse/location**.
4. Implementation + review of the booking call (not provided here), then setting
   the variables above.

Official references: `https://track.delhivery.com/api/v1/packages/json/` (tracking,
`Authorization: Token <token>`) and the Delhivery Express API docs at
`https://delhivery-express-api-doc.readme.io`.

---

## Frontend CORS configuration

- Set `CORS_ORIGINS` to the exact frontend origin(s), e.g. `http://localhost:3000` or `https://draftox.in`.
- Requests with `credentials: true` are only accepted from those origins; everything else gets no CORS headers (browsers block it).
- `FRONTEND_URL` is used for post-OAuth redirects and should match the primary origin.
