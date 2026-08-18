# @pulgueta/wompi-convex

Subscriptions and product checkouts for [Wompi](https://wompi.co) on
[Convex](https://convex.dev).

Wompi has no products, subscriptions, or billing cycles — it gives you
transactions, tokenized cards, and payment sources. This component supplies the
missing billing engine on top of [`@pulgueta/wompi`](https://npmjs.com/package/@pulgueta/wompi),
with the schema conventions you know from Stripe/Polar/Paddle:

- **One-time checkouts** through Wompi Web Checkout (signed redirect URLs).
- **Subscriptions on saved cards**: trials, renewals, dunning retries,
  cancel-at-period-end, plan changes — computed by the component, charged
  through the Wompi API.
- **Webhooks** with checksum verification, replay dedupe, and amount guards.
- **Real-time state**: every payment and subscription is a Convex document;
  your UI updates the moment a webhook (or the billing cron) lands.
- **Self-healing**: stale pending payments are reconciled against the Wompi
  API, so the system converges even if a webhook never arrives.
- **Payout dispersions** (Pagos a Terceros): pay third parties into bank
  accounts or BRE-B keys and track every batch reactively from payout
  webhooks.

All Wompi API calls and secrets stay in **your app's environment**; the
component stores only billing state. Card data never touches your backend —
tokenization happens browser → Wompi with your public key.

```sh
npm install @pulgueta/wompi-convex @pulgueta/wompi
```

## Wiring (four small files)

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import wompi from "@pulgueta/wompi-convex/convex.config.js";

const app = defineApp();
app.use(wompi);
export default app;
```

```sh
npx convex env set WOMPI_PUBLIC_KEY pub_test_...
npx convex env set WOMPI_PRIVATE_KEY prv_test_...
npx convex env set WOMPI_EVENTS_KEY test_events_...
npx convex env set WOMPI_INTEGRITY_KEY test_integrity_...
```

```ts
// convex/wompi.ts
import { Wompi } from "@pulgueta/wompi-convex";
import { components } from "./_generated/api";

export const wompi = new Wompi(components.wompi, {
  // Bridge to your auth. Throw if there is no user.
  getUserInfo: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    return { userId: identity.tokenIdentifier, email: identity.email! };
  },
  // Your catalog — Wompi has no product API, the component owns it.
  products: [
    { key: "tee", name: "Camiseta", type: "one_time", amountInCents: 8_990_000 },
    {
      key: "pro",
      name: "Pro",
      type: "subscription",
      amountInCents: 2_990_000,
      interval: "month",
      trialDays: 7,
    },
  ],
});

// Re-export the prebuilt public API. Identity always comes from getUserInfo.
export const {
  getConfig,
  listProducts,
  getCurrentSubscription,
  listSubscriptions,
  listPayments,
  getPayment,
  checkout,
  confirmTransaction,
  subscribe,
  cancelSubscription,
  resumeSubscription,
  changeSubscription,
} = wompi.api();
```

```ts
// convex/http.ts
import { httpRouter } from "convex/server";
import { wompi } from "./wompi";

const http = httpRouter();
wompi.registerRoutes(http); // POST /wompi/webhook
export default http;
```

```ts
// convex/crons.ts — the billing engine's heartbeat
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.interval("wompi billing", { minutes: 15 }, internal.billing.run, {});
export default crons;

// convex/billing.ts
import { wompi } from "./wompi";
export const run = wompi.billing();
```

Seed the catalog once (`wompi.syncProducts(ctx)` from any mutation, or a small
internal mutation you `npx convex run`). In the Wompi dashboard, point the
sandbox "Eventos" URL at `https://<deployment>.convex.site/wompi/webhook`.

## One-time checkout

```tsx
const checkout = useAction(api.wompi.checkout);

const buy = async () => {
  const { url } = await checkout({
    productKey: "tee",
    redirectUrl: window.location.origin,
  });
  window.location.href = url; // Wompi Web Checkout
};
```

The action creates a pending `payments` row with a unique reference, signs the
amount with your integrity key, and returns the redirect URL. The prebuilt
action only takes a `productKey`: the amount always comes from your catalog,
never from the browser. For custom amounts, descriptions or metadata call
`wompi.checkout(ctx, { redirectUrl, amountInCents, metadata })` from your own
server function, where you control the inputs. Wompi sends the customer back
with `?id=<transactionId>` — confirm it for instant feedback (webhooks resolve
it anyway):

```tsx
const confirm = useAction(api.wompi.confirmTransaction);

useEffect(() => {
  const id = new URLSearchParams(location.search).get("id");
  if (id) void confirm({ transactionId: id });
}, []);
```

`confirmTransaction` fetches the transaction from the Wompi API and runs it
through the same idempotent state machine webhooks use — safe to call any
number of times, from anywhere. The prebuilt action requires a signed-in user
and only returns the payment when it belongs to that user; for anyone else it
returns the bare outcome code. Wompi lets a payer retry a declined Web
Checkout attempt under the same reference: a later `APPROVED` transaction
supersedes the declined one (`supersededTransactionIds` keeps the history).

## Subscriptions

Tokenize in the browser (public key, PCI-friendly), subscribe in one action:

```tsx
import { useWompiTokenizer } from "@pulgueta/wompi-convex/react";

const { tokenizeCard, acceptancePermalink, personalDataAuthPermalink, ready } =
  useWompiTokenizer(api.wompi.getConfig);
const subscribe = useAction(api.wompi.subscribe);

const onSubmit = async (card) => {
  const token = await tokenizeCard(card); // browser → Wompi, never your server
  await subscribe({
    productKey: "pro",
    token: token.id,
    paymentMethod: { brand: token.brand, lastFour: token.last_four },
  });
};
```

`subscribe` creates the Wompi payment source, inserts the subscription, and
charges the first period — polling briefly so the common sandbox/production
case resolves before the action returns. Trials skip the initial charge and
convert automatically when they end. Wompi requires two acceptance tokens on
every payment source and transaction (terms of use and personal-data
authorization); `subscribe` fetches both from the merchant and sends them, so
show the user both `acceptancePermalink` and `personalDataAuthPermalink` next
to the card form. Calling `subscribe` twice while the first charge is in
flight (double submit, action retry) reuses the same pending payment and
reference — it never mints a second charge.

Subscription state is a reactive query:

```tsx
const subscription = useQuery(api.wompi.getCurrentSubscription, {});
// status: "incomplete" | "trialing" | "active" | "past_due" | "unpaid" | "canceled"
const isEntitled = ["active", "trialing", "past_due"].includes(
  subscription?.status ?? "",
);
```

Server-side gating uses the same call through the instance:

```ts
const subscription = await wompi.getCurrentSubscription(ctx, { userId });
```

## How billing works

Wompi has no subscription engine, so the component is one:

1. Every subscription carries `nextChargeAt`. The cron's `claimDue` mutation
   atomically claims everything due — renewals, trial conversions, dunning
   retries — and finalizes cancel-at-period-end subscriptions (never charging
   them).
2. Each claim creates a pending payment with a **deterministic reference**
   (`wmps_<subscription>_<period>_<attempt>`) and a lease. Wompi enforces
   reference uniqueness, so a crashed run can never double-charge: the retry
   either reuses the pending row or hits Wompi's duplicate-reference error and
   reconciles the existing transaction instead.
3. Charges run against the saved payment source
   (`payment_source_id` + `payment_method.installments`). Results — from the
   charge response, a webhook, or redirect confirmation — all flow through one
   idempotent `applyTransaction` state machine. A charge whose response never
   arrives (timeout, 5xx, network) is left pending rather than marked failed:
   the next claim reuses the same reference, Wompi rejects the duplicate, and
   the existing transaction is reconciled — never a second charge. Only a
   rejected request (4xx) finalizes an attempt as `error`.
4. Failed renewals walk a dunning ladder (default retries at +1d, +2d, +4d;
   `past_due` keeps access as grace). Exhausted dunning marks the subscription
   `unpaid` (or `canceled`, your choice). Price snapshots are taken at
   subscribe time; catalog price changes only affect new subscribers. Plan
   changes apply at the next renewal, without proration.
5. The same cron sweeps stale pending payments: ones with a transaction id are
   reconciled against the API; ones without are looked up by reference
   (server-side charges every run, checkouts once before expiring) so a
   payment that reached Wompi without a webhook is still recorded; abandoned
   checkouts expire after ~26h. A late `APPROVED` still reopens an expired or
   declined row.

Defaults are tunable:

```ts
new Wompi(components.wompi, {
  getUserInfo,
  billing: {
    maxRetries: 3,
    retryScheduleMs: [86_400_000, 172_800_000, 345_600_000],
    onExhausted: "mark_unpaid", // or "cancel"
  },
  events: {
    onSubscriptionChange: async (ctx, subscription) => {
      // grant/revoke entitlements, send emails, ...
    },
    onPaymentChange: async (ctx, payment) => {},
  },
});
```

Callbacks fire once per state change, whether the change arrived via webhook,
cron, or confirmation: redeliveries and repeated confirmations are no-ops.
Payment callbacks run after the component state commits, so a crash between
the two can skip a callback (at-most-once) — a webhook retry reprocesses the
delivery when the state was not applied, but not when only the callback was
lost. Reconcile from `payments`/`subscriptions` if your side effects must be
exact.

## Dispersions (Pagos a Terceros)

The component also tracks payout dispersions — Wompi's API for paying third
parties into bank accounts or BRE-B keys. Payouts is a separate Wompi product
with its own credentials, taken from the Payouts developers section of the
dashboard:

```sh
npx convex env set WOMPI_PAYOUTS_API_KEY ...
npx convex env set WOMPI_PAYOUTS_USER_PRINCIPAL_ID ...
npx convex env set WOMPI_PAYOUTS_EVENTS_KEY ...
```

(or pass them as `payouts: { apiKey, userPrincipalId, eventsKey }` in the
`Wompi()` config). Everything payout-related is optional: apps that never pay
third parties are unaffected, and credentials are only checked when a
dispersion feature is actually used.

Create a batch from an action; the component records it as a `dispersions`
row keyed by the Wompi payout id:

```ts
const { dispersion } = await wompi.createDispersion(
  ctx,
  {
    reference: "providers-2026-07",
    accountId: "<origin account id>", // from the Payouts dashboard
    paymentType: "PROVIDERS",
    transactions: [
      {
        // Bank account destination...
        legalIdType: "CC",
        legalId: "1000000000",
        bankId: "<bank id>",
        accountType: "AHORROS",
        accountNumber: "12345678",
        name: "John Doe",
        amount: 1_000_000,
      },
      {
        // ...or a BRE-B key — both kinds mix in one batch.
        key: "@JUANPEREZ",
        name: "Juan Pérez",
        email: "juan@example.com",
        amount: 500_000,
      },
    ],
  },
  { idempotencyKey: "providers-2026-07" },
);
```

Preview the masked holder of a BRE-B key before paying it (read-only, nothing
is persisted):

```ts
const holder = await wompi.resolveBrebKey("@JUANPEREZ", "ALPHANUMERIC");
```

In the Payouts developers section, point the events URL at
`https://<deployment>.convex.site/wompi/payouts-webhook` (rename the path with
`registerRoutes(http, { payoutsPath })`). Payout events are signed with their
**own** secret: `WOMPI_PAYOUTS_EVENTS_KEY` is the Payouts events secret, not
the payments `WOMPI_EVENTS_KEY`. As `payout.updated` and `transaction.updated`
events land, the batch and its per-beneficiary transactions update in place —
status is always a reactive query away:

```ts
const dispersion = await wompi.getDispersion(ctx, { wompiPayoutId });
const pending = await wompi.listDispersions(ctx, { status: "PENDING" });
```

`transactionsSuccess` and `transactionsFailed` are Wompi's create-response
validation counts (accepted for processing vs rejected before processing), not
beneficiary settlement totals. Read per-beneficiary outcomes from the tracked
transactions.

For durable side effects, configure `events.onDispersionChange` with an app
internal mutation reference:

```ts
// convex/payoutEvents.ts
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

export const onDispersionChange = internalMutation({
  args: {
    dispersion: v.object({
      wompiPayoutId: v.string(),
      reference: v.string(),
      status: v.string(),
      paymentType: v.string(),
      transactionsTotal: v.number(),
      transactionsSuccess: v.number(),
      transactionsFailed: v.number(),
      amountInCents: v.optional(v.number()),
      finalizedAt: v.optional(v.number()),
    }),
  },
  handler: async (ctx, { dispersion }) => {
    // update app tables, enqueue work, ...
  },
});

// in the Wompi configuration
import { internal } from "./_generated/api";

events: {
  onDispersionChange: internal.payoutEvents.onDispersionChange,
},
```

The verified delivery, component update, callback mutation, and deduplication
outcome commit atomically. If the callback throws, the whole transaction rolls
back and Wompi's retry can safely replay it; completed redeliveries are no-ops.

## Security model

- Secrets live in Convex environment variables, read app-side by the `Wompi`
  class. The component's tables never store keys.
- Webhooks are authenticated with Wompi's checksum (SHA-256 over the signed
  properties + timestamp + events secret, constant-time compare) via
  `verifyWebhookEvent` from `@pulgueta/wompi/server`. Invalid signatures get a
  403; replays are deduplicated by checksum.
- `applyTransaction` enforces amount/currency equality against the payment
  row, so a transaction crafted against your public key with a reused
  reference and a 1-cent amount grants nothing.
- Component functions are only callable from your server functions; everything
  in `api()` that touches user data resolves identity through `getUserInfo`,
  never from client args. `checkout` only accepts a catalog `productKey`
  (amounts and metadata are never client-supplied), and `confirmTransaction`
  redacts payments that belong to another user.

## Tables

| Table | Purpose |
| --- | --- |
| `customers` | Your users in the billing domain (`userId` ↔ email). |
| `products` | The catalog you define (`one_time` or `subscription` with interval/trial). |
| `paymentSources` | Saved Wompi payment sources (brand/last four for display, `termsAcceptedAt`). |
| `subscriptions` | The state machine: status, period, `nextChargeAt`, dunning counters. |
| `payments` | One row per charge attempt, keyed by unique Wompi reference. |
| `dispersions` | Payout batches (Pagos a Terceros), keyed by Wompi payout id. |
| `dispersionTransactions` | Per-beneficiary payout transactions, upserted from webhooks. |
| `webhookEvents` | Verified deliveries, deduped by checksum, pruned by the cron. |

## Current limitations

- Cards only for subscriptions today. Nequi sources are accepted but
  `nequi_token.updated` events are recorded without activating the source.
- No proration on plan changes (they apply at the next renewal).
- Refunds/voids update payment rows and surface a note, but never mutate
  subscription periods — handle refund policy in `onPaymentChange`.

## License

Apache-2.0
