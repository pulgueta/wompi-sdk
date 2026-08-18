---
name: wompi-go-to-production
description: >
  Go-live checklist for @pulgueta/wompi integrations. Verifies environment
  variables for publicKey, privateKey, and integrityKey; sandbox vs production
  URL switching; unique transaction references per charge; amount_in_cents
  integer precision (never floats, already in cents); and complete error-tuple
  handling before responding to clients. Includes a full end-to-end card
  transaction example from client form data through server response.
  Load before deploying a Wompi integration or reviewing production readiness.
type: lifecycle
library: '@pulgueta/wompi'
library_version: "3.0.0"
requires:
  - wompi-client-setup
  - wompi-transactions
sources:
  - "pulgueta/wompi-node:packages/core/README.md"
  - "pulgueta/wompi-node:packages/core/CHANGELOG.md"
  - "pulgueta/wompi-node:packages/core/src/schemas.ts"
---

# @pulgueta/wompi — Go-to-Production Checklist

Run through each section before deploying your Wompi integration.

## Key Management Checks

### Check: API keys are loaded from environment variables

Expected:

```typescript
const wompi = new WompiClient({
  publicKey: process.env.WOMPI_PUBLIC_KEY!,
  privateKey: process.env.WOMPI_PRIVATE_KEY!,
  sandbox: process.env.NODE_ENV !== 'production',
});

const signature = await getSignatureKey({
  reference,
  amountInCents,
  integrityKey: process.env.WOMPI_INTEGRITY_KEY!, // third key — integrity secret
});
```

Fail condition: Any key appears as a string literal in source code.

Fix: Move all three keys (`WOMPI_PUBLIC_KEY`, `WOMPI_PRIVATE_KEY`, `WOMPI_INTEGRITY_KEY`) to `.env` / secrets manager. Never commit them.

---

### Check: Sandbox and production keys are not mixed

Expected:

- `sandbox: true` → use sandbox keys (`pub_test_*`, `prv_test_*`)
- `sandbox: false` → use production keys (`pub_prod_*`, `prv_prod_*`)

Fail condition: `sandbox: false` is set but `WOMPI_PUBLIC_KEY` starts with `pub_test_`.

Fix: Maintain separate environment variable sets for each environment. Confirm each set in the Wompi dashboard before going live.

---

### Check: `privateKey` is provided for all admin operations

Expected:

```typescript
const wompi = new WompiClient({
  publicKey: process.env.WOMPI_PUBLIC_KEY!,
  privateKey: process.env.WOMPI_PRIVATE_KEY!, // required if using any of the operations below
});
```

Fail condition: `privateKey` is omitted and your code calls `listTransactions`, `voidTransaction`, `paymentSources.*`, `paymentLinks.createPaymentLink`, or `paymentLinks.updatePaymentLink`.

Fix: Provide `privateKey`. Without it these methods return `[WompiError, null]` silently — no throw.

## Transaction Integrity Checks

### Check: `amountInCents` is a positive integer already in cents

Expected:

```typescript
const amountInCents = 2_490_000; // COP 24,900 — expressed in cents, never multiplied

const signature = await getSignatureKey({ reference, amountInCents, integrityKey });
await wompi.transactions.createTransaction({ amount_in_cents: amountInCents, ... });
```

Fail condition: `amountInCents` is a float (`24900.5`), or divided/multiplied from a pesos value (`price * 100`).

Fix: Store and compute prices in cents throughout your system. Never convert inside `getSignatureKey` or `createTransaction`.

---

### Check: Each transaction uses a unique `reference`

Expected:

```typescript
const reference = `order-${orderId}-${Date.now()}`;
// or use a UUID: import { randomUUID } from 'crypto'; const reference = randomUUID();
```

Fail condition: A static string (`'my-order'`) or shared counter is used as `reference`.

Fix: Combine a stable order/user identifier with a timestamp or UUID so no two charges share the same reference.

---

### Check: `expirationTime` in `getSignatureKey` matches `expiration_time` in transaction

Expected:

```typescript
const expirationTime = '2026-12-31T23:59:59.000Z';

const signature = await getSignatureKey({ reference, amountInCents, integrityKey, expirationTime });
await wompi.transactions.createTransaction({ ..., expiration_time: expirationTime });
```

Fail condition: `expirationTime` is passed to `getSignatureKey` but `expiration_time` is omitted from `createTransaction`, or vice versa.

Fix: Use the same constant for both. If you don't need an expiration, omit `expirationTime` from both calls.

## Error Handling Checks

### Check: Every method's error tuple is checked before using data

Expected:

```typescript
const [error, txn] = await wompi.transactions.createTransaction(input);
if (error) {
  return res.status(400).json({ error: error.message });
}
// Only access txn after confirming error is null
await db.save({ wompiId: txn.id, status: txn.status });
return res.json({ id: txn.id });
```

Fail condition: `data` is accessed without checking `error` first, or calls are wrapped in `try/catch` only.

Fix: Destructure and check `error` from every SDK call. The SDK never throws on API errors — `try/catch` catches nothing for declined transactions or validation failures.

---

### Check: Transaction result is persisted before responding to the client

Expected:

```typescript
const [error, txn] = await wompi.transactions.createTransaction(input);
if (error) return res.status(400).json({ error: error.message });

// Persist FIRST — respond AFTER
await db.insert(transactions).values({ wompiId: txn.id, status: txn.status, ... });
return res.json({ id: txn.id, status: txn.status });
```

Fail condition: `res.json(...)` is called before `await db.insert(...)`.

Fix: Always write to your database before sending the response. If the write fails, you get a 500 but the Wompi record is still recoverable from the Wompi dashboard.

## End-to-End Example

Complete card transaction from client-submitted form data through server:

```typescript
import { Hono } from 'hono';
import { WompiClient } from '@pulgueta/wompi';
import { getSignatureKey } from '@pulgueta/wompi/server';

const app = new Hono();
const wompi = new WompiClient({
  publicKey: process.env.WOMPI_PUBLIC_KEY!,
  privateKey: process.env.WOMPI_PRIVATE_KEY!,
  sandbox: process.env.NODE_ENV !== 'production',
});

app.post('/pay', async (c) => {
  const { cardNumber, cvc, expMonth, expYear, cardHolder, email, amountCOP } = await c.req.json();

  // amount must be a positive integer in cents
  const amountInCents = Math.round(Number(amountCOP)); // e.g. 2490000 for COP 24,900
  if (!Number.isInteger(amountInCents) || amountInCents < 1) {
    return c.json({ error: 'Invalid amount' }, 400);
  }

  // Fresh acceptance tokens per transaction — Wompi requires both consents
  const [merchantErr, merchant] = await wompi.merchants.getMerchant();
  if (merchantErr) return c.json({ error: merchantErr.message }, 500);
  const acceptanceToken = merchant.presigned_acceptance?.acceptance_token;
  const personalAuthToken = merchant.presigned_personal_data_auth?.acceptance_token;
  if (!acceptanceToken || !personalAuthToken) {
    return c.json({ error: 'Could not get acceptance tokens' }, 500);
  }

  // Tokenize card
  const [tokenErr, token] = await wompi.tokens.tokenizeCard({
    number: cardNumber,
    cvc,
    exp_month: expMonth,
    exp_year: expYear,
    card_holder: cardHolder,
  });
  if (tokenErr) return c.json({ error: tokenErr.message }, 422);

  // Sign — amountInCents is hashed as-is, never multiply
  const reference = `order-${Date.now()}`;
  const signature = await getSignatureKey({
    reference,
    amountInCents,
    integrityKey: process.env.WOMPI_INTEGRITY_KEY!,
  });

  // Create transaction
  const [txnErr, txn] = await wompi.transactions.createTransaction({
    acceptance_token: acceptanceToken,
    accept_personal_auth: personalAuthToken,
    amount_in_cents: amountInCents,
    currency: 'COP',
    signature,
    customer_email: email,
    reference,
    payment_method: { type: 'CARD', token: token.id, installments: 1 },
  });
  if (txnErr) return c.json({ error: txnErr.message }, 400);

  // Persist before responding
  await db.insert(payments).values({
    wompiId: txn.id,
    status: txn.status,
    reference: txn.reference,
    amountInCents: txn.amount_in_cents,
    email,
  });

  return c.json({ id: txn.id, status: txn.status });
});
```

## Common Mistakes

### CRITICAL Hardcoding API keys in source code

Wrong:

```typescript
const wompi = new WompiClient({
  publicKey: 'pub_prod_ABC123XYZ',  // committed to git
  privateKey: 'prv_prod_SECRETKEY',
});
const signature = await getSignatureKey({ integrityKey: 'integrity_SECRET' });
```

Correct:

```typescript
const wompi = new WompiClient({
  publicKey: process.env.WOMPI_PUBLIC_KEY!,
  privateKey: process.env.WOMPI_PRIVATE_KEY!,
});
const signature = await getSignatureKey({ integrityKey: process.env.WOMPI_INTEGRITY_KEY! });
```

The integrity key can be used to forge transaction signatures. Hardcoded keys in source control expose merchant credentials to anyone with repository access.

Source: README, maintainer interview

---

### HIGH Using a non-unique `reference` across transactions

Wrong:

```typescript
// Same reference every time — Wompi may deduplicate or collide
await wompi.transactions.createTransaction({ reference: 'checkout', ... });
```

Correct:

```typescript
const reference = `order-${orderId}-${crypto.randomUUID()}`;
await wompi.transactions.createTransaction({ reference, ... });
```

Wompi uses `reference` for deduplication and reporting. Reusing the same value across separate charges produces unpredictable behavior.

Source: README, Wompi API semantics

---

### HIGH Passing a float or pre-converted value as `amount_in_cents`

Wrong:

```typescript
const price = 24900; // intent: COP 24,900 — but this is already in pesos, not cents
await wompi.transactions.createTransaction({ amount_in_cents: price, ... });
// Wompi receives 24,900 cents (COP 249) instead of COP 24,900

// Also wrong — float rejected by Zod
await wompi.transactions.createTransaction({ amount_in_cents: 24900.50, ... });
```

Correct:

```typescript
const amountInCents = 2_490_000; // COP 24,900 expressed in cents
await wompi.transactions.createTransaction({ amount_in_cents: amountInCents, ... });
```

COP amounts are large. COP 24,900 = 2,490,000 cents. `amount_in_cents` must be a positive integer.

Source: `packages/core/src/schemas.ts` — `MAX_AMOUNT_IN_CENTS`, README

## Pre-Deploy Summary

- [ ] All three keys (`WOMPI_PUBLIC_KEY`, `WOMPI_PRIVATE_KEY`, `WOMPI_INTEGRITY_KEY`) loaded from environment variables — no hardcoded strings
- [ ] `sandbox: process.env.NODE_ENV !== 'production'` (not hardcoded `true` or `false`)
- [ ] Sandbox and production key sets are confirmed in Wompi dashboard
- [ ] `privateKey` provided if using `listTransactions`, `voidTransaction`, payment sources, or payment link writes
- [ ] `amountInCents` is a positive integer in cents — never a float, never divided from pesos
- [ ] Every transaction uses a unique `reference` (order ID + timestamp or UUID)
- [ ] `expirationTime` in `getSignatureKey` matches `expiration_time` in `createTransaction` (or both omitted)
- [ ] Every SDK call checks the error tuple before accessing data
- [ ] Database write happens before HTTP response is sent

## See also

- `wompi-client-setup/SKILL.md` — key configuration and error-tuple pattern
- `wompi-transactions/SKILL.md` — full transaction lifecycle
- `wompi-server-integration/SKILL.md` — Hono/Elysia wiring with database persistence
