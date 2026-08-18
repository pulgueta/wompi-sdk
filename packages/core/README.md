# @pulgueta/wompi

This is the **unofficial** Wompi SDK. This package features a simpler abstraction for the Wompi API, making it easier to interact as a developer and to integrate into your projects.

## AI Agent Skills

If you use an AI coding agent (Claude Code, Cursor, Copilot, etc.), run:

```bash
pnpx @tanstack/intent@latest install
```

This installs focused skill files covering client setup, transactions, payment sources, payment links, server integration, and a go-to-production checklist — so your agent produces correct Wompi code without hallucinating APIs.

## Installation

To install this package, you can use NPM, Yarn, or PNPM:

```bash
npm install @pulgueta/wompi
```

```bash
yarn add @pulgueta/wompi
```

```bash
pnpm add @pulgueta/wompi
```

`zod` (v4) is a peer dependency — install it alongside the SDK if it is not already in your project.

## Usage

### Creating a client

Create a client with the keys from your Wompi dashboard. Only `publicKey` is
required; `privateKey` unlocks the private endpoints (listing transactions,
voiding, payment sources, payment links), and `sandbox` switches the base URL
from production to the sandbox.

```typescript
import { WompiClient } from "@pulgueta/wompi";

const wompi = new WompiClient({
  publicKey: process.env.WOMPI_PUBLIC_KEY!,
  privateKey: process.env.WOMPI_PRIVATE_KEY, // optional
  sandbox: true, // optional, defaults to false (production)
});
```

### Error handling

Every client method returns an error-first tuple — `[error, data]` — instead of
throwing. When `error` is `null`, `data` holds the parsed response; when `error`
is set, `data` is `null`.

```typescript
const [error, response] = await wompi.transactions.getTransaction("txn-id");

if (error) {
  // `error` is a `WompiError`, or one of its subclasses: `WompiNotFoundError`,
  // `WompiValidationError`, `WompiRequestError`.
  console.error(error.message);
  return;
}

console.log(response.status); // fully typed
```

### Creating a transaction

A card transaction needs an acceptance token, a card token, and an integrity
signature:

```typescript
import { WompiClient } from "@pulgueta/wompi";
import { getSignatureKey } from "@pulgueta/wompi/server";

const wompi = new WompiClient({
  publicKey: process.env.WOMPI_PUBLIC_KEY!,
  privateKey: process.env.WOMPI_PRIVATE_KEY,
  sandbox: true,
});

// 1. Acceptance tokens from the merchant — Wompi requires both consents.
const [merchantError, merchant] = await wompi.merchants.getMerchant();
if (merchantError) throw merchantError;
const acceptanceToken = merchant.presigned_acceptance?.acceptance_token;
const personalAuthToken =
  merchant.presigned_personal_data_auth?.acceptance_token;
if (!acceptanceToken) {
  throw new Error("Missing acceptance token in merchant response");
}

// 2. Tokenize the card.
const [tokenError, token] = await wompi.tokens.tokenizeCard({
  number: "4242424242424242",
  cvc: "123",
  exp_month: "12",
  exp_year: "29",
  card_holder: "Pedro Pérez",
});
if (tokenError) throw tokenError;

// 3. Sign the reference + amount with your integrity key.
const reference = `order-${Date.now()}`;
const amountInCents = 2_490_000;
const signature = await getSignatureKey({
  reference,
  amountInCents,
  integrityKey: process.env.WOMPI_INTEGRITY_KEY!,
});

// 4. Create the transaction.
const [error, transaction] = await wompi.transactions.createTransaction({
  acceptance_token: acceptanceToken,
  accept_personal_auth: personalAuthToken,
  amount_in_cents: amountInCents,
  currency: "COP",
  signature,
  customer_email: "buyer@example.com",
  reference,
  payment_method: { type: "CARD", token: token.id, installments: 1 },
});
if (error) throw error;

console.log(transaction.id, transaction.status);
```

### Computing the integrity signature

`getSignatureKey` produces the SHA-256 signature Wompi requires. `amountInCents`
is hashed as-is — it is already in cents and must not be multiplied — and
`expirationTime` is passed only when the transaction also sets `expiration_time`.

```typescript
import { getSignatureKey } from "@pulgueta/wompi/server";

const signature = await getSignatureKey({
  reference: "order-12345",
  amountInCents: 2_490_000,
  integrityKey: process.env.WOMPI_INTEGRITY_KEY!,
  currency: "COP", // optional, defaults to "COP"
  // expirationTime: "2025-01-01T00:00:00.000Z", // optional
});
```

### Available operations

| Namespace              | Methods                                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| `wompi.merchants`      | `getMerchant()`                                                                                             |
| `wompi.transactions`   | `getTransaction(id)`, `listTransactions(params)`, `createTransaction(input)`, `voidTransaction(id, input?)` |
| `wompi.tokens`         | `tokenizeCard(input)`, `tokenizeNequi(input)`, `getNequiToken(id)`                                          |
| `wompi.paymentSources` | `getPaymentSource(id)`, `createPaymentSource(input)`                                                        |
| `wompi.paymentLinks`   | `getPaymentLink(id)`, `createPaymentLink(input)`, `updatePaymentLink(id, input)`                            |
| `wompi.pse`            | `getFinancialInstitutions()`                                                                                |

`listTransactions`, `voidTransaction`, and every `paymentSources` / `paymentLinks`
write requires a `privateKey`.

### Payouts (Pagos a Terceros)

Bank account dispersions live on their own Wompi API — different host,
`x-api-key` + `user-principal-id` authentication and camelCase fields — so the
SDK exposes them through a dedicated client:

```typescript
import { WompiPayoutsClient } from "@pulgueta/wompi";

const payouts = new WompiPayoutsClient({
  apiKey: process.env.WOMPI_PAYOUTS_API_KEY!,
  userPrincipalId: process.env.WOMPI_PAYOUTS_USER_PRINCIPAL_ID!,
  sandbox: true,
});

const [error, created] = await payouts.createPayout(
  {
    reference: "payroll-2026-07",
    accountId: "account-id", // from payouts.listAccounts()
    paymentType: "PAYROLL",
    transactions: [
      {
        personType: "NATURAL",
        legalIdType: "CC",
        legalId: "1000000000",
        bankId: "bank-id", // from payouts.listBanks()
        accountType: "AHORROS",
        accountNumber: "12345678",
        name: "John Doe",
        email: "john@example.com",
        amount: 1_000_000, // cents
      },
    ],
  },
  { idempotencyKey: "payroll-2026-07" },
);
```

Pass `personType` explicitly. Wompi's OpenAPI schema requires it, while Wompi's
prose example omits it, so the SDK accepts omission for compatibility and does
not choose a default. Idempotency keys prevent reuse for Wompi's 24-hour
retention window; persist the returned payout ID and batch reference.

Available operations: `createPayout`, `createPayoutFromFile`, `resolveBrebKey`,
`listPayouts`, `getPayout`, `listPayoutTransactions`, `getPayoutTransaction`,
`listTransactionsByReference`, `listBanks`, `listAccounts`, `getLimits`,
`listReports`, `getReportDownloadUrl`, `getHealth`, and the sandbox-only
`rechargeAccountBalance`. Payout webhooks are verified with
`verifyPayoutEvent` / `isPayoutUpdatedEvent` / `isPayoutTransactionUpdatedEvent`
from `@pulgueta/wompi/server`.

`listTransactionsByReference` accepts a payout batch reference, not an
individual transaction reference.

### BRE-B dispersions

The same client and credentials also disperse through BRE-B keys, served on
`/v2` of the Payouts API. Resolve the key first, confirm the masked holder
data with your user, then pay the `key` instead of the bank destination trio:

```typescript
const [resolveError, holder] = await payouts.resolveBrebKey("@JUANPEREZ", "ALPHANUMERIC");
// holder → { holderName: "JUA*** PER*** GAR***", financialEntity: { name: "BANCOLOMBIA", code: "001" }, ... }

const [error, created] = await payouts.createPayout(
  {
    reference: "providers-2026-07",
    accountId: "account-id",
    paymentType: "PROVIDERS",
    transactions: [
      { key: "@JUANPEREZ", name: "Juan Perez", email: "juan@example.com", amount: 150_000 },
    ],
  },
  { idempotencyKey: "providers-2026-07" },
);
```

`createPayout` posts to `/v2/payouts` as soon as any transaction carries a
`key`, and to `/v1/payouts` otherwise. Batches mixing BRE-B and bank
transactions in one `transactions` array are supported (they go to `/v2`);
a single transaction must pay either a `key` or a bank account, never both.

### Subpath exports

| Import                    | Contents                                                                         |
| ------------------------- | -------------------------------------------------------------------------------- |
| `@pulgueta/wompi`         | `WompiClient`, `WompiPayoutsClient`                                              |
| `@pulgueta/wompi/server`  | `getSignatureKey`, `verifyWebhookEvent`, `verifyPayoutEvent`, `buildCheckoutUrl` |
| `@pulgueta/wompi/schemas` | Zod schemas, inferred types, `WompiError` and its subclasses, `Result`           |
