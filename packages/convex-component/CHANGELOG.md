# Changelog

## 0.3.0

### Minor Changes

- [#43](https://github.com/pulgueta/wompi-node/pull/43)
  [`af39b0b`](https://github.com/pulgueta/wompi-node/commit/af39b0bc7c78b0f1d961c9b1443eb9d22fa7bac4)
  Thanks [@pulgueta](https://github.com/pulgueta)! - Production-readiness fixes
  for the billing engine and the prebuilt API.
  - Payments: a declined, errored or expired row can still be approved (or
    voided) by a later Wompi transaction that shares the reference — Web
    Checkout payer retries no longer strand a paid order. Superseded transaction
    ids are kept in `supersededTransactionIds`.
  - Charges whose response never arrived (timeout, 5xx, network) are left
    pending instead of being finalized as `error`, so the next attempt reuses
    the same reference and reconciles the existing transaction instead of
    charging twice. The sweep also looks tx-less rows up by reference.
  - `subscribe` called twice while the first charge is in flight reuses the same
    pending payment instead of minting a second one. Resume charges are numbered
    by a `resumeAttempts` counter on the subscription (new optional field) and
    pending rows are found through a new `payments.by_subscription_id_status`
    index.
  - A duplicate-reference rejection whose follow-up lookup fails leaves the
    payment pending for the sweep instead of finalizing it as `error`; when
    Wompi holds several transactions for one reference, an approved one wins,
    then the newest.
  - Payments webhook: a redelivery whose first delivery crashed after being
    recorded is reprocessed instead of short-circuited.
  - `api().confirmTransaction` requires a signed-in user and redacts payments of
    other users; `api().checkout` now only accepts a catalog `productKey` (use
    `wompi.checkout(ctx, …)` server-side for custom amounts/metadata).
  - Both Wompi acceptance tokens (`acceptance_token`, `accept_personal_auth`)
    are sent on payment sources and charges — `subscribe` fails when the
    merchant exposes only one; `useWompiTokenizer` exposes
    `personalDataAuthPermalink` and clears both links when the client changes;
    payment sources record `termsAcceptedAt`.
  - `registerRoutes({ onEvent })` is documented as at-least-once: make the
    callback idempotent.
  - Packaging: `publishConfig.access` set, `react` peer dependency marked
    optional, `build` always cleans `dist`.

### Patch Changes

- Updated dependencies
  [[`4bd636e`](https://github.com/pulgueta/wompi-node/commit/4bd636e141155490fb37ef684ec8394f8038c983),
  [`2b7012c`](https://github.com/pulgueta/wompi-node/commit/2b7012c81dcbf2ef2f89bda8edd078126b39fee8)]:
  - @pulgueta/wompi@3.3.0

## 0.2.0

### Minor Changes

- [#30](https://github.com/pulgueta/wompi-node/pull/30)
  [`a341aa8`](https://github.com/pulgueta/wompi-node/commit/a341aa8b5e6afe4c86baf78997b825a308a25bac)
  Thanks [@pulgueta](https://github.com/pulgueta)! - Add payout dispersion
  (Pagos a Terceros) tracking to the Convex component.
  - New `dispersions` and `dispersionTransactions` tables record payout batches
    keyed by Wompi payout id, updated in place from `payout.updated` /
    `transaction.updated` webhook events — including batches created outside the
    component.
  - New `createDispersion` creates a bank/BRE-B batch through
    `WompiPayoutsClient` (idempotency-key protected) and records it;
    `resolveBrebKey` previews the masked holder of a BRE-B key; `getDispersion`
    / `listDispersions` expose reactive batch status.
  - `registerRoutes` now also mounts a Payouts events endpoint (default
    `/wompi/payouts-webhook`, configurable via `payoutsPath`) verified with the
    separate `WOMPI_PAYOUTS_EVENTS_KEY` secret, deduplicated by checksum, with a
    new `events.onDispersionChange` callback firing exactly once per batch state
    change.
  - New optional `payouts` config (`apiKey`, `userPrincipalId`, `eventsKey`,
    with `WOMPI_PAYOUTS_*` env fallbacks); apps not using dispersions are
    unaffected.

### Patch Changes

- [#24](https://github.com/pulgueta/wompi-node/pull/24)
  [`cdad2c8`](https://github.com/pulgueta/wompi-node/commit/cdad2c884b4223e7a867ca2a8cd168988cd6a84a)
  Thanks [@pulgueta](https://github.com/pulgueta)! - Remove the bundled live
  example app and its development dependencies.

- Updated dependencies
  [[`d94b031`](https://github.com/pulgueta/wompi-node/commit/d94b031a63513560a7144dd4c3136658463f84b9),
  [`2c9f33f`](https://github.com/pulgueta/wompi-node/commit/2c9f33fdc61d4991827121f26986d9f216a47b8a)]:
  - @pulgueta/wompi@3.2.0

## 0.1.0

### Minor Changes

- [#21](https://github.com/pulgueta/wompi-node/pull/21)
  [`99a56d6`](https://github.com/pulgueta/wompi-node/commit/99a56d6252b75f5d028c0e42b1874f02d977e3a9)
  Thanks [@pulgueta](https://github.com/pulgueta)! - Initial release:
  subscriptions and product checkouts for Wompi on Convex.
  - One-time checkouts through Wompi Web Checkout: `wompi.checkout()` creates a
    referenced pending payment and a signed redirect URL; `confirmTransaction`
    reconciles the redirect return through the same idempotent state machine
    webhooks use.
  - Subscriptions on saved cards: browser-side tokenization (`useWompiTokenizer`
    from `/react`), payment-source creation, initial charge, trials,
    calendar-aware renewals, dunning retries with configurable schedule,
    cancel-at-period-end, resume, and renewal-time plan changes.
  - A billing engine Wompi doesn't have: an app-owned cron (`wompi.billing()`)
    claims due charges with deterministic references and leases
    (double-charge-safe by construction), finalizes cancellations, reconciles
    stale pendings against the Wompi API, and prunes the webhook event log.
  - Webhooks: `registerRoutes(http)` mounts a checksum-verified endpoint with
    replay dedupe, amount/currency guards against forged references, and
    exactly-once `onPaymentChange`/`onSubscriptionChange` callbacks.
  - Reactive by default: customers, products, payment sources, subscriptions and
    payments are component tables; `wompi.api()` exposes prebuilt
    queries/actions (`getCurrentSubscription`, `listPayments`, `subscribe`, …)
    that resolve identity through your `getUserInfo` bridge.

  Secrets stay in your deployment's environment variables — the component stores
  billing state only.

### Patch Changes

- Updated dependencies
  [[`6fa999a`](https://github.com/pulgueta/wompi-node/commit/6fa999afc2089bbb411b0bd13e4822b7408973ea)]:
  - @pulgueta/wompi@3.1.0

## 0.0.0

- Initial release.
