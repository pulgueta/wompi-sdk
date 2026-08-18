---
name: wompi-transactions
description: >
  Full Wompi transaction lifecycle using @pulgueta/wompi. Covers getMerchant
  for acceptance_token and accept_personal_auth, tokenizeCard and
  tokenizeNequi, getSignatureKey for
  SHA-256 integrity signature (amountInCents as-is, never multiplied),
  createTransaction with payment_method or payment_source_id, getTransaction,
  listTransactions with from_date/until_date/status filters, voidTransaction
  with nested data.transaction result, and pse.getFinancialInstitutions.
  Load when processing payments, tokenizing cards, computing signatures, or
  querying transaction history.
type: core
library: '@pulgueta/wompi'
library_version: "3.0.0"
requires:
  - wompi-client-setup
sources:
  - "pulgueta/wompi-node:packages/core/src/client/transactions/index.ts"
  - "pulgueta/wompi-node:packages/core/src/client/tokens/index.ts"
  - "pulgueta/wompi-node:packages/core/src/client/merchants/index.ts"
  - "pulgueta/wompi-node:packages/core/src/server.ts"
  - "pulgueta/wompi-node:packages/core/src/schemas.ts"
  - "pulgueta/wompi-node:packages/core/CHANGELOG.md"
---

This skill builds on `wompi/client-setup`. Read it first for key configuration and the error-first tuple pattern.

## Setup

Complete card transaction: acceptance token → tokenize card → compute signature → create transaction.

```typescript
import { WompiClient } from '@pulgueta/wompi';
import { getSignatureKey } from '@pulgueta/wompi/server';

const wompi = new WompiClient({
  publicKey: process.env.WOMPI_PUBLIC_KEY!,
  privateKey: process.env.WOMPI_PRIVATE_KEY!,
  sandbox: process.env.NODE_ENV !== 'production',
});

// 1. Fresh acceptance tokens — fetch both for each transaction. Show the two
//    permalinks (presigned_acceptance.permalink, presigned_personal_data_auth.permalink)
//    and send the tokens only after the customer accepts.
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
  card_holder: 'Pedro Pérez',
});
if (tokenErr) throw tokenErr;

// 3. Compute integrity signature — amountInCents is hashed as-is (already in cents)
const reference = `order-${Date.now()}`;
const amountInCents = 2_490_000; // COP 24,900 expressed in cents
const signature = await getSignatureKey({
  reference,
  amountInCents,
  integrityKey: process.env.WOMPI_INTEGRITY_KEY!,
});

// 4. Create the transaction
const [error, txn] = await wompi.transactions.createTransaction({
  acceptance_token: acceptanceToken,
  accept_personal_auth: personalAuthToken,
  amount_in_cents: amountInCents,
  currency: 'COP',
  signature,
  customer_email: 'buyer@example.com',
  reference,
  payment_method: { type: 'CARD', token: token.id, installments: 1 },
});
if (error) throw error;

console.log(txn.id, txn.status); // 'txn-xxx', 'PENDING' | 'APPROVED'
```

## Core Patterns

### Compute an integrity signature with optional expiration

Include `expirationTime` only when `createTransaction` also sets `expiration_time`. Both values must be identical — Wompi hashes them together.

```typescript
import { getSignatureKey } from '@pulgueta/wompi/server';

const expirationTime = '2026-12-31T23:59:59.000Z';

const signature = await getSignatureKey({
  reference: 'order-12345',
  amountInCents: 2_490_000,
  integrityKey: process.env.WOMPI_INTEGRITY_KEY!,
  currency: 'COP',          // optional, defaults to 'COP'
  expirationTime,            // only when transaction sets expiration_time
});

await wompi.transactions.createTransaction({
  signature,
  amount_in_cents: 2_490_000,
  reference: 'order-12345',
  expiration_time: expirationTime, // must match value passed to getSignatureKey
  // ...
});
```

### List and filter transactions

`listTransactions` requires `privateKey`. Dates must be `YYYY-MM-DD` (not ISO timestamps). `page_size` max is 200.

```typescript
const [error, list] = await wompi.transactions.listTransactions({
  from_date: '2024-01-01',
  until_date: '2024-12-31',
  status: 'APPROVED',
  payment_method_type: 'CARD',
  page: 1,
  page_size: 50,
  order: 'DESC',
});
if (error) throw error;
console.log(list.length, list[0]?.id);
```

### Void a transaction and read the result

`voidTransaction` requires `privateKey`. The voided transaction is nested under `data.transaction`, not `data` directly. The response body may be empty (`undefined`) for a `201`.

```typescript
const [error, result] = await wompi.transactions.voidTransaction('txn-123', {
  amount_in_cents: 2_490_000, // optional — omit to void the full amount
});
if (error) throw error;

const voided = result?.transaction; // nested under .transaction
console.log(voided?.id, voided?.status); // 'txn-123', 'VOIDED'
```

### Tokenize Nequi and poll for status

Nequi tokenization is asynchronous. The token starts as `PENDING` and transitions to `APPROVED` or `DECLINED`.

```typescript
const [tokenErr, nequiToken] = await wompi.tokens.tokenizeNequi({
  phone_number: '3001234567',
});
if (tokenErr) throw tokenErr;

// Poll until approved
const [pollErr, updated] = await wompi.tokens.getNequiToken(nequiToken.id);
if (pollErr) throw pollErr;
console.log(updated.status); // 'PENDING' | 'APPROVED' | 'DECLINED'
```

## Common Mistakes

### CRITICAL Multiplying `amountInCents` by 100 before `getSignatureKey`

Wrong:

```typescript
const priceInPesos = 24900;
const signature = await getSignatureKey({
  reference,
  amountInCents: priceInPesos * 100, // 2,490,000,000 — wrong, double-multiplied
  integrityKey: process.env.WOMPI_INTEGRITY_KEY!,
});
```

Correct:

```typescript
const amountInCents = 2_490_000; // COP 24,900 already in cents
const signature = await getSignatureKey({
  reference,
  amountInCents, // same value passed to amount_in_cents in createTransaction
  integrityKey: process.env.WOMPI_INTEGRITY_KEY!,
});
```

In v1 the SDK multiplied internally (a bug). In v2 `amountInCents` is hashed exactly as given. Multiplying again produces a signature Wompi rejects silently — the transaction is declined.

Source: `CHANGELOG v2.0.0`, `packages/core/test/server-utils.test.ts`

---

### CRITICAL Using positional arguments with `getSignatureKey` (v1 API)

Wrong:

```typescript
// v1 positional API — does not exist in v2
const signature = await getSignatureKey(reference, amountInCents, integrityKey);
```

Correct:

```typescript
import { getSignatureKey } from '@pulgueta/wompi/server';

const signature = await getSignatureKey({
  reference,
  amountInCents,
  integrityKey: process.env.WOMPI_INTEGRITY_KEY!,
});
```

`getSignatureKey` was changed to a named-options object in v2.0.0. Positional calls fail at runtime or produce wrong signatures.

Source: `CHANGELOG v2.0.0`

---

### HIGH Caching the acceptance token across multiple transactions

Wrong:

```typescript
// Module-level cache — token expires and causes transaction rejections
const merchant = await wompi.merchants.getMerchant();
const acceptanceToken = merchant[1]!.presigned_acceptance!.acceptance_token;

// Later, in a route handler:
await wompi.transactions.createTransaction({ acceptance_token: acceptanceToken, ... });
```

Correct:

```typescript
// Fetch fresh tokens for each transaction
const [merchantErr, merchant] = await wompi.merchants.getMerchant();
if (merchantErr) throw merchantErr;
const acceptanceToken = merchant.presigned_acceptance?.acceptance_token;
const personalAuthToken = merchant.presigned_personal_data_auth?.acceptance_token;
if (!acceptanceToken || !personalAuthToken) throw new Error('Missing acceptance tokens');
```

Source: `packages/core/src/client/merchants/index.ts`, README

---

### HIGH `expirationTime` in signature must match `expiration_time` in transaction

Wrong:

```typescript
// Signature includes expirationTime, but createTransaction omits expiration_time
const signature = await getSignatureKey({
  reference, amountInCents, integrityKey,
  expirationTime: '2026-01-01T00:00:00.000Z',
});
await wompi.transactions.createTransaction({
  signature, reference, amount_in_cents: amountInCents,
  // expiration_time missing — hash mismatch, transaction rejected
});
```

Correct:

```typescript
const expirationTime = '2026-01-01T00:00:00.000Z';
const signature = await getSignatureKey({ reference, amountInCents, integrityKey, expirationTime });
await wompi.transactions.createTransaction({
  signature, reference, amount_in_cents: amountInCents,
  expiration_time: expirationTime, // must match exactly
});
```

Source: `packages/core/src/server.ts`

---

### HIGH Reading `voidTransaction` result from `data` instead of `data.transaction`

Wrong:

```typescript
const [error, result] = await wompi.transactions.voidTransaction('txn-123');
console.log(result?.id);     // undefined — wrong nesting
console.log(result?.status); // this is the VOID outcome, not the transaction
```

Correct:

```typescript
const [error, result] = await wompi.transactions.voidTransaction('txn-123');
if (error) throw error;
const voided = result?.transaction; // voided transaction is nested here
console.log(voided?.id, voided?.status);  // 'txn-123', 'VOIDED'
```

`voidTransaction` wraps the outcome: `data.status` is the void result, `data.transaction` is the voided transaction. Breaking change in v2.0.0.

Source: `CHANGELOG v2.0.0`, `packages/core/test/transactions.test.ts`

---

### MEDIUM Providing both `payment_method` and `payment_source_id`

Wrong:

```typescript
await wompi.transactions.createTransaction({
  payment_method: { type: 'CARD', token: 'tok_123', installments: 1 },
  payment_source_id: 456, // cannot provide both
  // ...
});
// Returns [WompiError, null] with "Invalid input" — no HTTP call made
```

Correct:

```typescript
// Card token: use payment_method (authenticated with publicKey)
await wompi.transactions.createTransaction({
  payment_method: { type: 'CARD', token: 'tok_123', installments: 1 },
  // ...
});

// Saved source: use payment_source_id (authenticated with privateKey)
await wompi.transactions.createTransaction({
  payment_source_id: 456,
  // ...
});
```

Source: `packages/core/src/schemas.ts` — `CreateTransactionInputSchema` `.refine()`

---

### MEDIUM Wrong date format in `listTransactions` filters

Wrong:

```typescript
await wompi.transactions.listTransactions({
  from_date: '2024-01-01T00:00:00Z', // ISO timestamp rejected
  page_size: 500,                     // max is 200
});
```

Correct:

```typescript
await wompi.transactions.listTransactions({
  from_date: '2024-01-01', // YYYY-MM-DD only
  until_date: '2024-12-31',
  page_size: 50,           // 1–200
});
```

Source: `packages/core/src/schemas.ts` — `TransactionListParamsSchema`

---

### HIGH Calling private-key methods without providing `privateKey`

Wrong:

```typescript
const wompi = new WompiClient({ publicKey: '...' });
const [error] = await wompi.transactions.listTransactions();
// error.message === "Private key is required" — no throw, silent failure
```

Correct:

```typescript
const wompi = new WompiClient({
  publicKey: process.env.WOMPI_PUBLIC_KEY!,
  privateKey: process.env.WOMPI_PRIVATE_KEY!,
});
```

`listTransactions` and `voidTransaction` require `privateKey`. Transactions using `payment_source_id` also require it.

Source: `packages/core/src/client/transactions/index.ts`

---

### HIGH Tension: Signature amount must match transaction amount exactly

Computing the signature early and then modifying `amount_in_cents` (e.g. adding tax or shipping) produces a mismatched signature that Wompi rejects.

```typescript
// BAD: amount changes after signing
const signature = await getSignatureKey({ reference, amountInCents: 1_000_000, integrityKey });
const finalAmount = 1_000_000 + taxAmount; // differs from signed amount
await wompi.transactions.createTransaction({ signature, amount_in_cents: finalAmount, ... });
```

Compute `amountInCents` once, use it in both `getSignatureKey` and `createTransaction`.

See also: `wompi-go-to-production/SKILL.md` § Common Mistakes

## See also

- `wompi-client-setup/SKILL.md` — key types and error-tuple pattern
- `wompi-payment-sources/SKILL.md` — recurring payments via `payment_source_id`
- `wompi-go-to-production/SKILL.md` — production checklist including full worked example
