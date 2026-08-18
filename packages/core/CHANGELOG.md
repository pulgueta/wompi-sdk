## 3.3.0

### Minor Changes

- [#43](https://github.com/pulgueta/wompi-node/pull/43) [`2b7012c`](https://github.com/pulgueta/wompi-node/commit/2b7012c81dcbf2ef2f89bda8edd078126b39fee8) Thanks [@pulgueta](https://github.com/pulgueta)! - Support Wompi's second acceptance token: `accept_personal_auth` on
  `createTransaction` / `createPaymentSource`, and `presigned_personal_data_auth`
  on the merchant response. Both tokens are now **required** on those two
  inputs — a request without `accept_personal_auth` is rejected locally with
  `Invalid input` before anything is sent, matching Wompi's contract. Read the
  token from `merchant.presigned_personal_data_auth.acceptance_token` and show
  its `permalink` next to the terms link. Input schemas no longer strip documented fields —
  `taxes`, `ip`, `recurrent`, `parent_transaction_id` and `payment_description`
  now reach the API. Payment-source `type` and `status` widened for `DAVIPLATA`,
  `BANCOLOMBIA_TRANSFER` and `VOIDED`.

### Patch Changes

- [#33](https://github.com/pulgueta/wompi-node/pull/33) [`4bd636e`](https://github.com/pulgueta/wompi-node/commit/4bd636e141155490fb37ef684ec8394f8038c983) Thanks [@pulgueta](https://github.com/pulgueta)! - Accept payout accounts whose balance is `null` in live API responses.

## 3.2.0

### Minor Changes

- [#29](https://github.com/pulgueta/wompi-node/pull/29) [`d94b031`](https://github.com/pulgueta/wompi-node/commit/d94b031a63513560a7144dd4c3136658463f84b9) Thanks [@pulgueta](https://github.com/pulgueta)! - Add BRE-B dispersions to `WompiPayoutsClient`.
  - New `resolveBrebKey(keyValue, keyType?)` previews the masked holder of a BRE-B key (`GET /v2/breb/keys/resolve/{keyValue}`) before paying it.
  - `createPayout` transactions now pay either a bank account or a BRE-B `key` — mixed batches included — and the batch is routed to `/v2/payouts` automatically whenever any transaction carries a `key`.
  - New `BrebKeyType`, `BrebFinancialEntity` and `BrebKeyResolution` schemas/types in `@pulgueta/wompi/schemas`, plus typed BRE-B payee fields (`key`, `keyType`, `personType`, `keyResolutionId`, `paymentMethodType`) on payout `transaction.updated` webhook events.

- [#28](https://github.com/pulgueta/wompi-node/pull/28) [`2c9f33f`](https://github.com/pulgueta/wompi-node/commit/2c9f33fdc61d4991827121f26986d9f216a47b8a) Thanks [@pulgueta](https://github.com/pulgueta)! - Add support for Wompi's Pagos a Terceros (Payouts) API — bank account dispersions.
  - New `WompiPayoutsClient` targeting `api.payouts.wompi.co` (and its sandbox), authenticated with `x-api-key` + `user-principal-id` headers: `createPayout` (immediate, scheduled and recurring batches, idempotency-key protected), `createPayoutFromFile` (WOMPI/PAB/SAP/DISFON/BANCO_OCCIDENTE_FC/DAVIVIENDA formats), `listPayouts`, `getPayout`, `listPayoutTransactions`, `getPayoutTransaction`, `listTransactionsByReference`, `listBanks`, `listAccounts`, `getLimits`, `listReports`, `getReportDownloadUrl`, `getHealth` and the sandbox-only `rechargeAccountBalance`.
  - New `verifyPayoutEvent`, `isPayoutUpdatedEvent` and `isPayoutTransactionUpdatedEvent` helpers in `@pulgueta/wompi/server` to authenticate `payout.updated` / `transaction.updated` webhook events.
  - New payout Zod schemas, inferred types and `WompiPayoutApiError` (carrying the `EXC_*` code and HTTP status) in `@pulgueta/wompi/schemas`.

## 3.1.0

### Minor Changes

- [#21](https://github.com/pulgueta/wompi-node/pull/21) [`6fa999a`](https://github.com/pulgueta/wompi-node/commit/6fa999afc2089bbb411b0bd13e4822b7408973ea) Thanks [@pulgueta](https://github.com/pulgueta)! - Add webhook event verification and Web Checkout URL building to `@pulgueta/wompi/server`, the two server-side primitives a payments integration needs beyond raw API calls:
  - `verifyWebhookEvent(payload, { eventsKey })` — parses and authenticates an event Wompi POSTs to your Events URL. It recomputes the SHA-256 checksum from `signature.properties` + `timestamp` + your events secret and compares it in constant time. Returns the SDK's usual `Result` tuple.
  - `computeEventChecksum(event, eventsKey)` — the low-level checksum, exposed for custom flows.
  - `isTransactionUpdatedEvent(event)` — type guard narrowing a verified event to a fully-typed `transaction.updated` payload.
  - `buildCheckoutUrl(options)` — builds a `https://checkout.wompi.co/p/?…` Web Checkout redirect URL, computing the integrity signature for you (or accepting a precomputed one), with support for redirect URL, expiration, customer data, shipping collection and taxes.

  `@pulgueta/wompi/schemas` now ships the matching schemas and types: `WebhookEventSchema`, `TransactionUpdatedEventSchema`, `NequiTokenUpdatedEventSchema`, `WebhookSignatureSchema`, their inferred types, and a new `WompiWebhookVerificationError` (discriminant `type: "WEBHOOK_VERIFICATION_ERROR"`).

  `CreateTransactionInputSchema` now accepts `payment_method` and `payment_source_id` **together** (previously exactly one was required). Charging a saved card source requires both — Wompi rejects source-only charges with "No se especificó el número de cuotas (installments)" — so the exactly-one refine became at-least-one, and `TransactionPaymentMethodSchema` gained an optional `installments` field. Inputs that passed validation before still do; inputs combining both fields are no longer rejected.

  These primitives power the new `@pulgueta/wompi-convex` component, but work in any runtime with Web Crypto (Node 20+, edge runtimes, Convex).

## 3.0.0

### Major Changes

- [#16](https://github.com/pulgueta/wompi-node/pull/16) [`23008dd`](https://github.com/pulgueta/wompi-node/commit/23008dd1c1925cb0498f1ad73c481341f6ab31ce) Thanks [@pulgueta](https://github.com/pulgueta)! - **Breaking changes**
  - The package root (`@pulgueta/wompi`) now exports only `WompiClient`. The integrity-signature helper `getSignatureKey` (and its `GetSignatureKeyOptions` type) moved to a new `@pulgueta/wompi/server` subpath, keeping the signing/crypto logic out of client bundles. Zod schemas, inferred types and error classes all live under `@pulgueta/wompi/schemas`.
  - Client methods now resolve to the entity directly instead of Wompi's `{ data, meta }` envelope. Read `response.status`, not `response.data.status`.

  Migration:

  ```diff
  - import { WompiClient, getSignatureKey } from "@pulgueta/wompi";
  + import { WompiClient } from "@pulgueta/wompi";
  + import { getSignatureKey } from "@pulgueta/wompi/server";

  - const [error, res] = await wompi.transactions.getTransaction(id);
  - res.data.status;
  + const [error, transaction] = await wompi.transactions.getTransaction(id);
  + transaction.status;
  ```

### Patch Changes

- [#16](https://github.com/pulgueta/wompi-node/pull/16) [`23008dd`](https://github.com/pulgueta/wompi-node/commit/23008dd1c1925cb0498f1ad73c481341f6ab31ce) Thanks [@pulgueta](https://github.com/pulgueta)! - fix: accept `null` values in payment-link response fields (`sku`, `expires_at`, `redirect_url`, `image_url`, `customer_data`)

  feat: SDK now returns `checkout_url` on payment-link responses, so callers don't have to build the URL manually

## 2.0.0

### Major Changes

- [#7](https://github.com/pulgueta/wompi-node/pull/7) [`f3e011d`](https://github.com/pulgueta/wompi-node/commit/f3e011d9d5f5afefe7ef73307b8b08759bd28353) Thanks [@pulgueta](https://github.com/pulgueta)! - Overhaul the SDK for type-safety and correctness. This is a breaking release.

  **Breaking changes**
  - `getSignatureKey` now takes an options object — `{ reference, amountInCents, integrityKey, currency?, expirationTime? }` — instead of positional arguments. It hashes `amountInCents` exactly as given (the previous build multiplied it by 100, producing wrong signatures) and throws a `WompiError` when the amount is not a non-negative integer.
  - `voidTransaction` resolves to the wrapped void outcome — the voided transaction is nested under `data.transaction` — or to `undefined` for an empty `201`. Code that read the transaction directly off `data` must be updated.

  **Fixes & improvements**
  - Response schemas are lenient: a successful Wompi response is never reported as a validation error. Non-identity fields are optional, unknown fields pass through, and drift-prone enums (`payment_method_type`, `accepted_payment_methods`, merchant `legal_id_type`) accept any string.
  - Empty `2xx` bodies are handled — they resolve to `undefined` instead of failing JSON parsing.
  - `PaymentMethodType` gains `BANCOLOMBIA_BNPL`, `DAVIPLATA`, `SU_PLUS` and `CARD_POS`.
  - Input validation is tightened: Zod email/URL formats, an `amount_in_cents` ceiling, a positive-integer `payment_source_id`, and a rule requiring exactly one of `payment_method` / `payment_source_id`.
  - The `Result` tuple types its error as the full `WompiError` union, so consumers can narrow on `.type` / `.statusCode` without `instanceof`.
  - `WompiClient` is re-exported from the package root (`@pulgueta/wompi`).

# 1.0.0 (2024-09-18)

### Bug Fixes

- build script ([6a09f7a](https://github.com/pulgueta/wompi-sdk/commit/6a09f7a811cfbe1789a271a2618064c3d3ce45e9))
- **ci:** add permission ([630330f](https://github.com/pulgueta/wompi-sdk/commit/630330f6d85cc7fa9ccc8b28903cd698c0b37bcd))
- **ci:** add required permissions ([48a73d0](https://github.com/pulgueta/wompi-sdk/commit/48a73d0a0a75daf356067233037b2198e0c604b6))
- **ci:** concurrency issue ([ae763a5](https://github.com/pulgueta/wompi-sdk/commit/ae763a59950e4ada454cfb49ead882845e07970b))
- **ci:** pnpm version ([51438ab](https://github.com/pulgueta/wompi-sdk/commit/51438abdfe0142e9b54207ed926e36f53e733d0f))
- **ci:** remove github wd ([5de8a0c](https://github.com/pulgueta/wompi-sdk/commit/5de8a0cc65c496e26b30261af1a3945d537e6d97))
- **ci:** remove working directory ([7e53cd1](https://github.com/pulgueta/wompi-sdk/commit/7e53cd171cd73d5fc8c3526300ef4733874bcd1e))
- **cI:** setup file ([ee1bbaa](https://github.com/pulgueta/wompi-sdk/commit/ee1bbaa089b3f9c8c82c604ae6e21de0744a2779))
- move changeset to core package ([40ba198](https://github.com/pulgueta/wompi-sdk/commit/40ba198ac9346dc16e410858b0c506e118d68767))

### Features

- add initial server features and main class ([8f4452f](https://github.com/pulgueta/wompi-sdk/commit/8f4452fff9f7c80259287b3701dba3d5336e083c))
- base classes for requests and client classes for public usage ([f31df52](https://github.com/pulgueta/wompi-sdk/commit/f31df52a70a0689c49c177d7974c4c52a137b7ba))
- create pse class ([6b52a84](https://github.com/pulgueta/wompi-sdk/commit/6b52a84d2784d43d7d8485c31d4adc9a1918f0bc))
- **create-turbo:** apply official-starter transform ([cab4332](https://github.com/pulgueta/wompi-sdk/commit/cab43329b5c003eed518b7c4d4fbc214768cc5e8))
- **create-turbo:** apply pnpm-eslint transform ([4006744](https://github.com/pulgueta/wompi-sdk/commit/40067449694a6ede132a1e50469ce24a7a22c515))
- **create-turbo:** create with-changesets ([4e93c73](https://github.com/pulgueta/wompi-sdk/commit/4e93c734d61c7f5d2e6b4ce66e35907b3bd3577a))
- **create-turbo:** install dependencies ([811bcdc](https://github.com/pulgueta/wompi-sdk/commit/811bcdce0269e36cd9694334627a0f9e0c2d32f1))
- validate parameters and build the query url from private methods ([09af461](https://github.com/pulgueta/wompi-sdk/commit/09af46127934b5f4a48d043de733b52c3f441cd0))
