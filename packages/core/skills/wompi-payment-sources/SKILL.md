---
name: wompi-payment-sources
description: >
  Create and retrieve reusable Wompi payment sources using @pulgueta/wompi.
  Covers createPaymentSource (CARD, NEQUI, DAVIPLATA or BANCOLOMBIA_TRANSFER;
  requires acceptance_token, accept_personal_auth and privateKey),
  getPaymentSource, PaymentSourceStatus (AVAILABLE/PENDING/VOIDED),
  and charging a customer via payment_source_id in createTransaction.
  Load when building recurring billing, saved payment methods, or subscription flows.
type: core
library: '@pulgueta/wompi'
library_version: "3.0.0"
requires:
  - wompi-client-setup
sources:
  - "pulgueta/wompi-node:packages/core/src/client/payment-sources/index.ts"
  - "pulgueta/wompi-node:packages/core/src/schemas.ts"
---

This skill builds on `wompi/client-setup`. Read it first for key configuration and the error-first tuple pattern.

## Setup

Tokenize a card, save it as a payment source, then use the source for a recurring charge.

```typescript
import { WompiClient } from '@pulgueta/wompi';
import { getSignatureKey } from '@pulgueta/wompi/server';

const wompi = new WompiClient({
  publicKey: process.env.WOMPI_PUBLIC_KEY!,
  privateKey: process.env.WOMPI_PRIVATE_KEY!, // required for all payment source operations
  sandbox: process.env.NODE_ENV !== 'production',
});

// 1. Get both acceptance tokens
const [merchantErr, merchant] = await wompi.merchants.getMerchant();
if (merchantErr) throw merchantErr;
const acceptanceToken = merchant.presigned_acceptance?.acceptance_token;
const personalAuthToken = merchant.presigned_personal_data_auth?.acceptance_token;
if (!acceptanceToken || !personalAuthToken) throw new Error('Missing acceptance tokens');

// 2. Tokenize the card
const [tokenErr, token] = await wompi.tokens.tokenizeCard({
  number: '4242424242424242',
  cvc: '123',
  exp_month: '12',
  exp_year: '29',
  card_holder: 'María García',
});
if (tokenErr) throw tokenErr;

// 3. Save as a payment source (CARD type)
const [sourceErr, source] = await wompi.paymentSources.createPaymentSource({
  type: 'CARD',
  token: token.id,
  acceptance_token: acceptanceToken,
  accept_personal_auth: personalAuthToken,
  customer_email: 'maria@example.com',
});
if (sourceErr) throw sourceErr;

console.log(source.id, source.status); // numeric id, 'AVAILABLE'
```

## Core Patterns

### Create a Nequi payment source

Nequi sources start as `PENDING` and become `AVAILABLE` after the customer approves in the Nequi app. Poll `getPaymentSource` or use webhooks to confirm availability.

```typescript
const [tokenErr, nequiToken] = await wompi.tokens.tokenizeNequi({
  phone_number: '3001234567',
});
if (tokenErr) throw tokenErr;

const [sourceErr, source] = await wompi.paymentSources.createPaymentSource({
  type: 'NEQUI',
  token: nequiToken.id,
  acceptance_token: acceptanceToken,
  accept_personal_auth: personalAuthToken,
  customer_email: 'user@example.com',
});
if (sourceErr) throw sourceErr;

// Check status — PENDING means awaiting customer approval
console.log(source.status); // 'PENDING' | 'AVAILABLE'
```

### Retrieve a payment source

```typescript
const [error, source] = await wompi.paymentSources.getPaymentSource(sourceId);
if (error) throw error;

if (source.status === 'AVAILABLE') {
  // Ready to charge
}
```

### Charge a customer using a saved payment source

Use `payment_source_id` in `createTransaction` instead of `payment_method`. This requires `privateKey` — the transaction is authenticated with the private key, not the public key.

```typescript
import { getSignatureKey } from '@pulgueta/wompi/server';

const amountInCents = 1_990_000; // COP 19,900 in cents
const reference = `subscription-${userId}-${Date.now()}`;

const signature = await getSignatureKey({
  reference,
  amountInCents,
  integrityKey: process.env.WOMPI_INTEGRITY_KEY!,
});

const [merchantErr, merchant] = await wompi.merchants.getMerchant();
if (merchantErr) throw merchantErr;
const acceptanceToken = merchant.presigned_acceptance?.acceptance_token;
const personalAuthToken = merchant.presigned_personal_data_auth?.acceptance_token;
if (!acceptanceToken || !personalAuthToken) throw new Error('Missing acceptance tokens');

const [error, txn] = await wompi.transactions.createTransaction({
  acceptance_token: acceptanceToken,
  accept_personal_auth: personalAuthToken,
  amount_in_cents: amountInCents,
  currency: 'COP',
  signature,
  customer_email: 'maria@example.com',
  reference,
  payment_source_id: source.id, // numeric id from createPaymentSource
});
if (error) throw error;

console.log(txn.id, txn.status);
```

## Common Mistakes

### HIGH Calling `paymentSources` methods without `privateKey`

Wrong:

```typescript
const wompi = new WompiClient({ publicKey: process.env.WOMPI_PUBLIC_KEY! });

const [error] = await wompi.paymentSources.createPaymentSource({ ... });
// error.message === "Private key is required for payment source operations"
// No HTTP call is made — returns immediately with error
```

Correct:

```typescript
const wompi = new WompiClient({
  publicKey: process.env.WOMPI_PUBLIC_KEY!,
  privateKey: process.env.WOMPI_PRIVATE_KEY!,
});
```

Both `createPaymentSource` and `getPaymentSource` require `privateKey`.

Source: `packages/core/src/client/payment-sources/index.ts`

---

### HIGH Omitting the acceptance tokens when creating a payment source

Wrong:

```typescript
await wompi.paymentSources.createPaymentSource({
  type: 'CARD',
  token: cardToken.id,
  customer_email: 'user@example.com',
  // acceptance_token and accept_personal_auth missing — Zod validation fails before HTTP call
});
```

Correct:

```typescript
const [merchantErr, merchant] = await wompi.merchants.getMerchant();
if (merchantErr) throw merchantErr;
const acceptanceToken = merchant.presigned_acceptance?.acceptance_token;
const personalAuthToken = merchant.presigned_personal_data_auth?.acceptance_token;
if (!acceptanceToken || !personalAuthToken) throw new Error('Missing acceptance tokens');

await wompi.paymentSources.createPaymentSource({
  type: 'CARD',
  token: cardToken.id,
  customer_email: 'user@example.com',
  acceptance_token: acceptanceToken,
  accept_personal_auth: personalAuthToken,
});
```

Both `acceptance_token` and `accept_personal_auth` are required in `createPaymentSource` — the same merchant tokens used for transactions. Fetch both fresh before each call, show the two permalinks (`presigned_acceptance.permalink`, `presigned_personal_data_auth.permalink`) to the customer, and send the tokens only after they accept.

Source: `packages/core/src/schemas.ts` — `CreatePaymentSourceInputSchema`

---

### MEDIUM Using `payment_source_id` in `createTransaction` without `privateKey`

Wrong:

```typescript
const wompi = new WompiClient({ publicKey: '...' }); // no privateKey

await wompi.transactions.createTransaction({
  payment_source_id: 123, // requires privateKey — will return error tuple
  amount_in_cents: 1_990_000,
  // ...
});
```

Correct:

```typescript
const wompi = new WompiClient({
  publicKey: process.env.WOMPI_PUBLIC_KEY!,
  privateKey: process.env.WOMPI_PRIVATE_KEY!,
});
```

Transactions using `payment_source_id` are authenticated with the private key. The public key is used for `payment_method` (inline card token) transactions only.

Source: `packages/core/src/client/transactions/index.ts`

---

### HIGH Not checking the error tuple before reading data

Wrong:

```typescript
const [, source] = await wompi.paymentSources.createPaymentSource(input);
await db.save({ sourceId: source.id }); // TypeError if error occurred
```

Correct:

```typescript
const [error, source] = await wompi.paymentSources.createPaymentSource(input);
if (error) throw error;
await db.save({ sourceId: source.id });
```

Source: `packages/core/src/schemas.ts`

## See also

- `wompi-client-setup/SKILL.md` — key types and error-tuple pattern
- `wompi-transactions/SKILL.md` — using `payment_source_id` in `createTransaction`
