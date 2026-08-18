---
"@pulgueta/wompi-convex": minor
---

Production-readiness fixes for the billing engine and the prebuilt API.

- Payments: a declined, errored or expired row can still be approved (or
  voided) by a later Wompi transaction that shares the reference — Web
  Checkout payer retries no longer strand a paid order. Superseded
  transaction ids are kept in `supersededTransactionIds`.
- Charges whose response never arrived (timeout, 5xx, network) are left
  pending instead of being finalized as `error`, so the next attempt reuses
  the same reference and reconciles the existing transaction instead of
  charging twice. The sweep also looks tx-less rows up by reference.
- `subscribe` called twice while the first charge is in flight reuses the
  same pending payment instead of minting a second one. Resume charges are
  numbered by a `resumeAttempts` counter on the subscription (new optional
  field) and pending rows are found through a new
  `payments.by_subscription_id_status` index.
- A duplicate-reference rejection whose follow-up lookup fails leaves the
  payment pending for the sweep instead of finalizing it as `error`; when
  Wompi holds several transactions for one reference, an approved one wins,
  then the newest.
- Payments webhook: a redelivery whose first delivery crashed after being
  recorded is reprocessed instead of short-circuited.
- `api().confirmTransaction` requires a signed-in user and redacts payments
  of other users; `api().checkout` now only accepts a catalog `productKey`
  (use `wompi.checkout(ctx, …)` server-side for custom amounts/metadata).
- Both Wompi acceptance tokens (`acceptance_token`, `accept_personal_auth`)
  are sent on payment sources and charges — `subscribe` fails when the
  merchant exposes only one; `useWompiTokenizer` exposes
  `personalDataAuthPermalink` and clears both links when the client changes;
  payment sources record `termsAcceptedAt`.
- `registerRoutes({ onEvent })` is documented as at-least-once: make the
  callback idempotent.
- Packaging: `publishConfig.access` set, `react` peer dependency marked
  optional, `build` always cleans `dist`.
