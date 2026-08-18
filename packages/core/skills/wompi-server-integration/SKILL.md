---
name: wompi-server-integration
description: >
  Wire @pulgueta/wompi into a Hono or Elysia backend. Covers importing Zod
  schemas from @pulgueta/wompi/schemas for route-level request validation,
  processing a Wompi transaction inside a server handler, persisting
  transaction results (id, status, reference, amount_in_cents) to a database
  before responding, and mapping WompiError subclasses to HTTP error responses.
  Load when integrating the SDK into a server framework or adding payment
  endpoints to an existing backend.
type: composition
library: '@pulgueta/wompi'
library_version: "3.0.0"
requires:
  - wompi-client-setup
  - wompi-transactions
sources:
  - "pulgueta/wompi-node:packages/core/src/schemas.ts"
  - "pulgueta/wompi-node:packages/core/package.json"
---

This skill requires familiarity with `wompi/client-setup` and `wompi/transactions`. Read those first.

## Integration Setup

### Hono

```typescript
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { WompiClient } from '@pulgueta/wompi';
import { getSignatureKey } from '@pulgueta/wompi/server';
import { TokenizeCardInputSchema } from '@pulgueta/wompi/schemas'; // use /schemas subpath

const app = new Hono();

const wompi = new WompiClient({
  publicKey: process.env.WOMPI_PUBLIC_KEY!,
  privateKey: process.env.WOMPI_PRIVATE_KEY!,
  sandbox: process.env.NODE_ENV !== 'production',
});

// Validate card input with the SDK's own Zod schema
app.post('/checkout', zValidator('json', TokenizeCardInputSchema), async (c) => {
  const cardInput = c.req.valid('json');

  // 1. Acceptance tokens
  const [merchantErr, merchant] = await wompi.merchants.getMerchant();
  if (merchantErr) return c.json({ error: merchantErr.message }, 500);
  const acceptanceToken = merchant.presigned_acceptance!.acceptance_token;
  const personalAuthToken = merchant.presigned_personal_data_auth!.acceptance_token;

  // 2. Tokenize
  const [tokenErr, token] = await wompi.tokens.tokenizeCard(cardInput);
  if (tokenErr) return c.json({ error: tokenErr.message }, 422);

  // 3. Sign
  const reference = `order-${Date.now()}`;
  const amountInCents = 2_490_000;
  const signature = await getSignatureKey({
    reference,
    amountInCents,
    integrityKey: process.env.WOMPI_INTEGRITY_KEY!,
  });

  // 4. Create transaction
  const [txnErr, txn] = await wompi.transactions.createTransaction({
    acceptance_token: acceptanceToken,
    accept_personal_auth: personalAuthToken,
    amount_in_cents: amountInCents,
    currency: 'COP',
    signature,
    customer_email: 'buyer@example.com',
    reference,
    payment_method: { type: 'CARD', token: token.id, installments: 1 },
  });
  if (txnErr) return c.json({ error: txnErr.message }, 400);

  // 5. Persist before responding
  await db.insert(transactions).values({
    wompiId: txn.id,
    status: txn.status,
    reference: txn.reference,
    amountInCents: txn.amount_in_cents,
  });

  return c.json({ id: txn.id, status: txn.status });
});
```

### Elysia

```typescript
import { Elysia, t } from 'elysia';
import { WompiClient } from '@pulgueta/wompi';
import { getSignatureKey } from '@pulgueta/wompi/server';

const wompi = new WompiClient({
  publicKey: process.env.WOMPI_PUBLIC_KEY!,
  privateKey: process.env.WOMPI_PRIVATE_KEY!,
  sandbox: process.env.NODE_ENV !== 'production',
});

new Elysia()
  .post('/checkout', async ({ body, error }) => {
    const [merchantErr, merchant] = await wompi.merchants.getMerchant();
    if (merchantErr) return error(500, merchantErr.message);
    const acceptanceToken = merchant.presigned_acceptance!.acceptance_token;
    const personalAuthToken = merchant.presigned_personal_data_auth!.acceptance_token;

    const [tokenErr, token] = await wompi.tokens.tokenizeCard(body);
    if (tokenErr) return error(422, tokenErr.message);

    const reference = `order-${Date.now()}`;
    const amountInCents = 2_490_000;
    const signature = await getSignatureKey({
      reference,
      amountInCents,
      integrityKey: process.env.WOMPI_INTEGRITY_KEY!,
    });

    const [txnErr, txn] = await wompi.transactions.createTransaction({
      acceptance_token: acceptanceToken,
      accept_personal_auth: personalAuthToken,
      amount_in_cents: amountInCents,
      currency: 'COP',
      signature,
      customer_email: body.card_holder,
      reference,
      payment_method: { type: 'CARD', token: token.id, installments: 1 },
    });
    if (txnErr) return error(400, txnErr.message);

    await db.insert(transactions).values({
      wompiId: txn.id,
      status: txn.status,
      reference: txn.reference,
      amountInCents: txn.amount_in_cents,
    });

    return { id: txn.id, status: txn.status };
  }, {
    body: t.Object({
      number: t.String(),
      cvc: t.String(),
      exp_month: t.String(),
      exp_year: t.String(),
      card_holder: t.String(),
    }),
  })
  .listen(3000);
```

## Core Integration Patterns

### Map WompiError subclasses to HTTP status codes

```typescript
import type { WompiErrorResult } from '@pulgueta/wompi/schemas';

function wompiErrorToStatus(error: WompiErrorResult): number {
  if ('type' in error && error.type === 'NOT_FOUND_ERROR') return 404;
  if ('type' in error && error.type === 'INPUT_VALIDATION_ERROR') return 422;
  if ('statusCode' in error) return error.statusCode || 500;
  return 500;
}

// In a Hono handler:
const [error, txn] = await wompi.transactions.createTransaction(input);
if (error) return c.json({ error: error.message }, wompiErrorToStatus(error));
```

### Reuse SDK Zod schemas for input validation

The `/schemas` subpath exports all Zod schemas. Import them into your route validators to avoid duplicating type definitions.

```typescript
import { TokenizeCardInputSchema, CreatePaymentLinkInputSchema } from '@pulgueta/wompi/schemas';

// Use directly with @hono/zod-validator, elysia, or zod .parse()
const cardData = TokenizeCardInputSchema.parse(rawInput);
```

## Common Mistakes

### MEDIUM Importing schemas from `@pulgueta/wompi` instead of `/schemas`

Wrong:

```typescript
import { TokenizeCardInputSchema } from '@pulgueta/wompi'; // not exported here
import { CreateTransactionInputSchema } from '@pulgueta/wompi/server'; // wrong subpath
```

Correct:

```typescript
import { TokenizeCardInputSchema } from '@pulgueta/wompi/schemas';
import { CreateTransactionInputSchema } from '@pulgueta/wompi/schemas';
```

The root export (`@pulgueta/wompi`) only exports `WompiClient`. All schemas are under the `/schemas` subpath.

Source: `packages/core/package.json` — exports map

---

### MEDIUM Not awaiting `getSignatureKey` — it returns a Promise

Wrong:

```typescript
// Missing await — signature is a Promise object, not a string
const signature = getSignatureKey({ reference, amountInCents, integrityKey });
await wompi.transactions.createTransaction({ signature, ... });
// Wompi receives "[object Promise]" as the signature — transaction rejected
```

Correct:

```typescript
const signature = await getSignatureKey({ reference, amountInCents, integrityKey });
```

`getSignatureKey` uses `crypto.subtle.digest` which is async.

Source: `packages/core/src/server.ts`

---

### HIGH Responding to client before persisting the transaction

Wrong:

```typescript
const [error, txn] = await wompi.transactions.createTransaction(input);
if (error) return c.json({ error: error.message }, 400);

return c.json({ id: txn.id }); // responded before DB write

await db.insert(transactions).values({ ... }); // unreachable
```

Correct:

```typescript
const [error, txn] = await wompi.transactions.createTransaction(input);
if (error) return c.json({ error: error.message }, 400);

// Persist first — if this throws, the client gets a 500 but you still have the Wompi record
await db.insert(transactions).values({
  wompiId: txn.id,
  status: txn.status,
  reference: txn.reference,
  amountInCents: txn.amount_in_cents,
});

return c.json({ id: txn.id, status: txn.status });
```

If the response is sent before the DB write and the write fails, the payment is charged but not recorded in your system.

Source: maintainer interview

## See also

- `wompi-transactions/SKILL.md` — full transaction lifecycle details
- `wompi-go-to-production/SKILL.md` — production checklist
