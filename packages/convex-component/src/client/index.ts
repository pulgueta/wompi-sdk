import {
  actionGeneric,
  createFunctionHandle,
  httpActionGeneric,
  internalActionGeneric,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import type {
  ApiFromModules,
  Auth,
  GenericActionCtx,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
  HttpRouter,
  FunctionReference,
} from "convex/server";
import { v } from "convex/values";
import type { Infer } from "convex/values";
import { WompiClient, WompiPayoutsClient } from "@pulgueta/wompi";
import {
  buildCheckoutUrl,
  getSignatureKey,
  isPayoutTransactionUpdatedEvent,
  isPayoutUpdatedEvent,
  isTransactionUpdatedEvent,
  verifyPayoutEvent,
  verifyWebhookEvent,
} from "@pulgueta/wompi/server";
import type {
  BrebKeyResolution,
  BrebKeyType,
  CreatePayoutInput,
  CreatePayoutResult,
  Merchant,
  Payout,
  PayoutPage,
  Result,
  Transaction,
  WebhookEvent,
  WompiErrorResult,
} from "@pulgueta/wompi/schemas";
import {
  WompiNotFoundError,
  WompiPayoutApiError,
  WompiRequestError,
  WompiValidationError,
} from "@pulgueta/wompi/schemas";
import type { ComponentApi } from "../component/_generated/component.js";
import {
  dispersionDoc,
  dispersionTransactionDoc,
  paymentDoc,
  paymentSourceInputValidator,
  productInputValidator,
  subscriptionDoc,
  subscriptionWithProduct,
} from "../component/shared.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PaymentDoc = Infer<typeof paymentDoc>;
export type DispersionDoc = Infer<typeof dispersionDoc>;
export type DispersionTransactionDoc = Infer<typeof dispersionTransactionDoc>;
export type DispersionChange = Pick<
  DispersionDoc,
  | "wompiPayoutId"
  | "reference"
  | "status"
  | "paymentType"
  | "transactionsTotal"
  | "transactionsSuccess"
  | "transactionsFailed"
  | "amountInCents"
  | "finalizedAt"
>;
export type SubscriptionDoc = Infer<typeof subscriptionDoc>;
export type SubscriptionWithProduct = Infer<typeof subscriptionWithProduct>;
export type WompiProductConfig = Infer<typeof productInputValidator>;
export type PaymentSourceInput = Infer<typeof paymentSourceInputValidator>;

type RunQueryCtx = { runQuery: GenericQueryCtx<GenericDataModel>["runQuery"] };
type RunMutationCtx = RunQueryCtx & {
  runMutation: GenericMutationCtx<GenericDataModel>["runMutation"];
};
type IdentityCtx = RunQueryCtx & { auth: Auth };
type ActionCtx = Pick<
  GenericActionCtx<GenericDataModel>,
  "runQuery" | "runMutation" | "runAction" | "auth"
>;

export type WompiUserInfo = {
  /** Stable app user id; the key everything in the component hangs off. */
  userId: string;
  email: string;
  fullName?: string;
  phoneNumber?: string;
  legalId?: string;
  legalIdType?: string;
};

export type ChargeOutcome = {
  outcome: string;
  paymentChanged: boolean;
  subscriptionChanged: boolean;
  payment: PaymentDoc | null;
  subscription: SubscriptionDoc | null;
  note?: string;
};

export type WompiEventCallbacks = {
  /** Fires whenever a payment row's status actually changes. */
  onPaymentChange?: (ctx: RunMutationCtx, payment: PaymentDoc) => void | Promise<void>;
  /** Fires whenever a subscription's state actually changes. */
  onSubscriptionChange?: (
    ctx: RunMutationCtx,
    subscription: SubscriptionDoc,
  ) => void | Promise<void>;
  /**
   * Internal app mutation called atomically whenever a dispersion row's state
   * actually changes. It receives `{ dispersion }`.
   */
  onDispersionChange?: FunctionReference<
    "mutation",
    "internal",
    { dispersion: DispersionChange },
    unknown
  >;
};

export type WompiPayoutsCredentials = {
  /** Defaults to `process.env.WOMPI_PAYOUTS_API_KEY`. */
  apiKey?: string;
  /** Defaults to `process.env.WOMPI_PAYOUTS_USER_PRINCIPAL_ID`. */
  userPrincipalId?: string;
  /** Defaults to `process.env.WOMPI_PAYOUTS_EVENTS_KEY`. */
  eventsKey?: string;
};

export type WompiBillingOptions = {
  /** Dunning retries after a failed renewal before giving up. Default 3. */
  maxRetries?: number;
  /** Delay before each dunning retry in ms; last entry repeats. Default [1d, 2d, 4d]. */
  retryScheduleMs?: number[];
  /** What happens when dunning is exhausted. Default "mark_unpaid". */
  onExhausted?: "mark_unpaid" | "cancel";
  /** Charge lease before the cron may re-attempt a claim. Default 10 min. */
  leaseMs?: number;
  /** How long an interactive charge polls Wompi for a final status. Default 8 × 1.5s. */
  pollAttempts?: number;
  pollIntervalMs?: number;
  /** Age before a pending payment is swept (reconciled or expired). Default 10 min. */
  pendingSweepAfterMs?: number;
  /** Age before an unstarted pending payment is marked expired. Default 26h. */
  expirePendingAfterMs?: number;
  /** Webhook event log retention. Default 30 days. */
  eventRetentionMs?: number;
};

export type WompiConfig = {
  /**
   * Bridge to your auth system. Runs inside your own functions, so use
   * `ctx.auth` / `ctx.runQuery` and throw if there is no authenticated user.
   */
  getUserInfo: (ctx: IdentityCtx) => Promise<WompiUserInfo>;
  /** Defaults to `process.env.WOMPI_PUBLIC_KEY`. */
  publicKey?: string;
  /** Defaults to `process.env.WOMPI_PRIVATE_KEY`. */
  privateKey?: string;
  /** Defaults to `process.env.WOMPI_EVENTS_KEY`. */
  eventsKey?: string;
  /** Defaults to `process.env.WOMPI_INTEGRITY_KEY`. */
  integrityKey?: string;
  /**
   * Defaults to `process.env.WOMPI_SANDBOX`, or — more usefully — is inferred
   * from the public key prefix (`pub_test_…` ⇒ sandbox).
   */
  sandbox?: boolean;
  /**
   * Pagos a Terceros (payout dispersion) credentials, from the Payouts
   * developers section of the Wompi dashboard. Fully optional — only checked
   * when a dispersion feature is actually used.
   */
  payouts?: WompiPayoutsCredentials;
  /** Static catalog pushed to the component via `syncProducts`. */
  products?: WompiProductConfig[];
  billing?: WompiBillingOptions;
  events?: WompiEventCallbacks;
};

const DAY_MS = 86_400_000;

const BILLING_DEFAULTS = {
  maxRetries: 3,
  retryScheduleMs: [DAY_MS, 2 * DAY_MS, 4 * DAY_MS],
  onExhausted: "mark_unpaid" as const,
  leaseMs: 10 * 60_000,
  pollAttempts: 8,
  pollIntervalMs: 1_500,
  pendingSweepAfterMs: 10 * 60_000,
  expirePendingAfterMs: 26 * 60 * 60_000,
  eventRetentionMs: 30 * DAY_MS,
};

export type ProcessBillingSummary = {
  claimed: number;
  approved: number;
  declined: number;
  stillPending: number;
  reconciled: number;
  finalizedCancellations: number;
  sweptPending: number;
  expired: number;
  errors: string[];
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Both acceptance tokens Wompi requires on transactions and payment sources. */
type AcceptanceTokens = {
  acceptanceToken: string;
  /** Personal-data authorization (habeas data); absent on merchants without it. */
  personalAuthToken?: string;
};

const acceptanceTokensFrom = (merchant: Merchant): AcceptanceTokens | null => {
  const acceptanceToken = merchant.presigned_acceptance?.acceptance_token;
  if (!acceptanceToken) return null;
  return {
    acceptanceToken,
    personalAuthToken: merchant.presigned_personal_data_auth?.acceptance_token,
  };
};

const TRANSACTION_STATUS_RANK: Record<string, number> = {
  APPROVED: 0,
  PENDING: 1,
  VOIDED: 2,
  DECLINED: 3,
  ERROR: 4,
};

/**
 * The transaction that decides a reference when Wompi holds several for it
 * (payer retries): an approved one wins, then the newest.
 */
const pickTransaction = (transactions: Transaction[]): Transaction =>
  [...transactions].sort(
    (a, b) =>
      (TRANSACTION_STATUS_RANK[a.status] ?? 9) - (TRANSACTION_STATUS_RANK[b.status] ?? 9) ||
      (b.created_at ?? "").localeCompare(a.created_at ?? ""),
  )[0];

/**
 * Whether a failed charge request may still have created a transaction at
 * Wompi. Only a rejected request (validation, not found, other 4xx) proves
 * nothing was created; timeouts, network failures, 5xx and throttling do
 * not — and neither does a 2xx whose body failed to parse.
 */
const chargeMayHaveReachedWompi = (error: WompiErrorResult): boolean => {
  if (error instanceof WompiValidationError || error instanceof WompiNotFoundError) return false;
  if (error instanceof WompiRequestError) {
    return (
      error.statusCode === 0 ||
      error.statusCode >= 500 ||
      error.statusCode === 408 ||
      error.statusCode === 429
    );
  }
  // The SDK rejects malformed input before any request is sent.
  return !error.message.startsWith("Invalid input");
};

/**
 * App-facing client for the Wompi Convex component.
 *
 * All Wompi API calls and secrets live here — in your app's environment —
 * while the component stores only reactive billing state. See the README for
 * the three pieces to wire up: `api()`, `registerRoutes(http)` and
 * `billing()` on a cron.
 */
export class Wompi {
  public readonly sandbox: boolean;
  private readonly publicKey: string;
  private readonly privateKey: string;
  private readonly eventsKey: string;
  private readonly integrityKey: string;
  private readonly payoutsApiKey: string;
  private readonly payoutsUserPrincipalId: string;
  private readonly payoutsEventsKey: string;
  private readonly billingOptions: Required<WompiBillingOptions>;
  private wompiClient: WompiClient | null = null;
  private wompiPayoutsClient: WompiPayoutsClient | null = null;

  constructor(
    public component: ComponentApi,
    private config: WompiConfig,
  ) {
    this.publicKey = config.publicKey ?? process.env.WOMPI_PUBLIC_KEY ?? "";
    this.privateKey = config.privateKey ?? process.env.WOMPI_PRIVATE_KEY ?? "";
    this.eventsKey = config.eventsKey ?? process.env.WOMPI_EVENTS_KEY ?? "";
    this.integrityKey = config.integrityKey ?? process.env.WOMPI_INTEGRITY_KEY ?? "";
    this.payoutsApiKey = config.payouts?.apiKey ?? process.env.WOMPI_PAYOUTS_API_KEY ?? "";
    this.payoutsUserPrincipalId =
      config.payouts?.userPrincipalId ?? process.env.WOMPI_PAYOUTS_USER_PRINCIPAL_ID ?? "";
    this.payoutsEventsKey =
      config.payouts?.eventsKey ?? process.env.WOMPI_PAYOUTS_EVENTS_KEY ?? "";
    this.sandbox =
      config.sandbox ??
      (process.env.WOMPI_SANDBOX !== undefined
        ? ["1", "true", "yes"].includes(process.env.WOMPI_SANDBOX.toLowerCase())
        : this.publicKey.startsWith("pub_test_"));
    this.billingOptions = { ...BILLING_DEFAULTS, ...config.billing };
  }

  private get client(): WompiClient {
    if (!this.wompiClient) {
      if (!this.publicKey) {
        throw new Error(
          "Wompi public key missing. Set WOMPI_PUBLIC_KEY (npx convex env set WOMPI_PUBLIC_KEY pub_test_...) or pass publicKey in the Wompi() config.",
        );
      }
      this.wompiClient = new WompiClient({
        publicKey: this.publicKey,
        privateKey: this.privateKey || undefined,
        sandbox: this.sandbox,
      });
    }
    return this.wompiClient;
  }

  private get payoutsClient(): WompiPayoutsClient {
    if (!this.wompiPayoutsClient) {
      if (!this.payoutsApiKey || !this.payoutsUserPrincipalId) {
        throw new Error(
          "Wompi payouts credentials missing. Set WOMPI_PAYOUTS_API_KEY and WOMPI_PAYOUTS_USER_PRINCIPAL_ID (npx convex env set WOMPI_PAYOUTS_API_KEY ...) or pass payouts.apiKey / payouts.userPrincipalId in the Wompi() config.",
        );
      }
      this.wompiPayoutsClient = new WompiPayoutsClient({
        apiKey: this.payoutsApiKey,
        userPrincipalId: this.payoutsUserPrincipalId,
        sandbox: this.sandbox,
      });
    }
    return this.wompiPayoutsClient;
  }

  private requireKey(key: string, name: string, envVar: string): string {
    if (!key) {
      throw new Error(
        `Wompi ${name} missing. Set ${envVar} (npx convex env set ${envVar} ...) or pass it in the Wompi() config.`,
      );
    }
    return key;
  }

  /** The billing config threaded into component mutations on every call. */
  private get billingConfig() {
    return {
      maxRetries: this.billingOptions.maxRetries,
      retryScheduleMs: this.billingOptions.retryScheduleMs,
      onExhausted: this.billingOptions.onExhausted,
      leaseMs: this.billingOptions.leaseMs,
    };
  }

  private async dispatch(ctx: RunMutationCtx, outcome: ChargeOutcome): Promise<void> {
    try {
      if (outcome.paymentChanged && outcome.payment) {
        await this.config.events?.onPaymentChange?.(ctx, outcome.payment);
      }
      if (outcome.subscriptionChanged && outcome.subscription) {
        await this.config.events?.onSubscriptionChange?.(ctx, outcome.subscription);
      }
    } catch (error) {
      // Component state is already consistent; a failing app callback must
      // not fail the webhook/cron that produced it.
      console.error("Wompi event callback failed:", error);
    }
  }

  // -------------------------------------------------------------------------
  // Catalog
  // -------------------------------------------------------------------------

  /** Push the static `products` config (plus any extras) into the component. */
  async syncProducts(
    ctx: RunMutationCtx,
    options?: { products?: WompiProductConfig[]; archiveMissing?: boolean },
  ) {
    const products = options?.products ?? this.config.products ?? [];
    return await ctx.runMutation(this.component.products.sync, {
      products,
      archiveMissing: options?.archiveMissing,
    });
  }

  async listProducts(ctx: RunQueryCtx, options?: { includeInactive?: boolean }) {
    return await ctx.runQuery(this.component.products.list, {
      includeInactive: options?.includeInactive,
    });
  }

  async getProduct(ctx: RunQueryCtx, args: { key: string }) {
    return await ctx.runQuery(this.component.products.getByKey, { key: args.key });
  }

  // -------------------------------------------------------------------------
  // Customers
  // -------------------------------------------------------------------------

  async ensureCustomer(ctx: RunMutationCtx & { auth: Auth }) {
    const user = await this.config.getUserInfo(ctx);
    const customer = await ctx.runMutation(this.component.customers.upsert, {
      userId: user.userId,
      email: user.email,
      fullName: user.fullName,
      phoneNumber: user.phoneNumber,
      legalId: user.legalId,
      legalIdType: user.legalIdType,
    });
    return { user, customer };
  }

  // -------------------------------------------------------------------------
  // One-time checkout (Wompi Web Checkout redirect)
  // -------------------------------------------------------------------------

  /**
   * Create a pending payment and the signed Web Checkout URL to redirect the
   * customer to. The unique reference ties the eventual Wompi transaction
   * back to this payment via webhook or `confirmTransaction`.
   */
  async checkout(
    ctx: ActionCtx,
    args: {
      redirectUrl: string;
      productKey?: string;
      amountInCents?: number;
      description?: string;
      expirationTime?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<{ url: string; reference: string; payment: PaymentDoc }> {
    const integrityKey = this.requireKey(
      this.integrityKey,
      "integrity key",
      "WOMPI_INTEGRITY_KEY",
    );
    const { user, customer } = await this.ensureCustomer(ctx);

    const reference = `wmpk_${crypto.randomUUID().replaceAll("-", "")}`;

    const payment = (await ctx.runMutation(this.component.payments.createCheckout, {
      reference,
      customerId: customer._id,
      userId: user.userId,
      productKey: args.productKey,
      amountInCents: args.amountInCents,
      description: args.description,
      metadata: args.metadata,
    })) as PaymentDoc;

    const url = await buildCheckoutUrl({
      publicKey: this.requireKey(this.publicKey, "public key", "WOMPI_PUBLIC_KEY"),
      reference,
      amountInCents: payment.amountInCents,
      currency: payment.currency,
      redirectUrl: args.redirectUrl,
      expirationTime: args.expirationTime,
      integrityKey,
      customerData: {
        email: user.email,
        fullName: user.fullName,
        phoneNumber: user.phoneNumber,
        legalId: user.legalId,
        legalIdType: user.legalIdType,
      },
    });

    return { url, reference, payment };
  }

  /**
   * Fetch a transaction from the Wompi API and run it through the same state
   * machine webhooks use. Call it on the redirect back from Web Checkout
   * (`?id=<transactionId>`) for instant feedback, or any time you need to
   * reconcile out-of-band. Safe to call repeatedly — it is idempotent.
   */
  async confirmTransaction(
    ctx: RunMutationCtx,
    args: { transactionId: string; poll?: boolean },
  ): Promise<ChargeOutcome> {
    let transaction: Transaction | null = null;
    const attempts = args.poll === false ? 1 : this.billingOptions.pollAttempts;

    for (let i = 0; i < attempts; i++) {
      const [error, fetched] = await this.client.transactions.getTransaction(
        args.transactionId,
      );
      if (error) throw error;
      transaction = fetched;
      if (transaction.status !== "PENDING") break;
      if (i < attempts - 1) await sleep(this.billingOptions.pollIntervalMs);
    }

    return await this.applyWompiTransaction(ctx, transaction!);
  }

  private async applyWompiTransaction(
    ctx: RunMutationCtx,
    transaction: Transaction,
  ): Promise<ChargeOutcome> {
    const outcome = (await ctx.runMutation(this.component.billing.applyTransaction, {
      reference: transaction.reference,
      wompiTransactionId: transaction.id,
      wompiStatus: transaction.status,
      amountInCents: transaction.amount_in_cents,
      currency: transaction.currency,
      paymentMethodType: transaction.payment_method_type,
      statusMessage: transaction.status_message ?? undefined,
      config: this.billingConfig,
    })) as ChargeOutcome;

    await this.dispatch(ctx, outcome);
    return outcome;
  }

  // -------------------------------------------------------------------------
  // Subscriptions
  // -------------------------------------------------------------------------

  /**
   * Subscribe the current user to a subscription product using a payment
   * token created in the browser (card data never touches your server).
   *
   * Creates the Wompi payment source, the subscription row, and — unless the
   * product has a trial — charges the first period immediately, polling
   * briefly for the final status.
   */
  async subscribe(
    ctx: ActionCtx,
    args: {
      productKey: string;
      token: string;
      type?: "CARD" | "NEQUI";
      paymentMethod?: Omit<PaymentSourceInput, "wompiSourceId" | "type" | "status">;
      /** Card installments for the initial charge (renewals always use 1). */
      installments?: number;
      metadata?: Record<string, unknown>;
    },
  ): Promise<{
    subscription: SubscriptionDoc;
    payment: PaymentDoc | null;
    outcome: ChargeOutcome | null;
  }> {
    this.requireKey(this.privateKey, "private key", "WOMPI_PRIVATE_KEY");
    const integrityKey = this.requireKey(
      this.integrityKey,
      "integrity key",
      "WOMPI_INTEGRITY_KEY",
    );

    const { user, customer } = await this.ensureCustomer(ctx);

    const [merchantError, merchant] = await this.client.merchants.getMerchant();
    if (merchantError) throw merchantError;
    const tokens = acceptanceTokensFrom(merchant);
    if (!tokens) {
      throw new Error("Could not fetch the merchant acceptance token from Wompi");
    }

    const [sourceError, source] = await this.client.paymentSources.createPaymentSource({
      type: args.type ?? "CARD",
      token: args.token,
      acceptance_token: tokens.acceptanceToken,
      accept_personal_auth: tokens.personalAuthToken,
      customer_email: user.email,
    });
    if (sourceError) throw sourceError;

    const { subscription, payment } = (await ctx.runMutation(
      this.component.subscriptions.create,
      {
        customerId: customer._id,
        userId: user.userId,
        productKey: args.productKey,
        paymentSource: {
          wompiSourceId: source.id,
          type: source.type ?? args.type ?? "CARD",
          status: source.status,
          ...args.paymentMethod,
        },
        metadata: args.metadata,
      },
    )) as { subscription: SubscriptionDoc; payment: PaymentDoc | null };

    if (!payment) {
      // Trial: no initial charge. Surface the new subscription to callbacks.
      await this.dispatch(ctx, {
        outcome: "applied",
        paymentChanged: false,
        subscriptionChanged: true,
        payment: null,
        subscription,
      });
      return { subscription, payment: null, outcome: null };
    }

    const outcome = await this.chargeClaimedPayment(ctx, {
      payment,
      customerEmail: user.email,
      wompiSourceId: source.id,
      tokens,
      integrityKey,
      pollAttempts: this.billingOptions.pollAttempts,
      installments: args.installments,
    });

    return {
      subscription: (outcome.subscription as SubscriptionDoc) ?? subscription,
      payment: outcome.payment ?? payment,
      outcome,
    };
  }

  /**
   * Charge a claimed pending payment against a saved payment source and
   * record the result. Shared by `subscribe` (initial charge) and the
   * billing cron (renewals/dunning).
   */
  private async chargeClaimedPayment(
    ctx: RunMutationCtx,
    args: {
      payment: PaymentDoc;
      customerEmail: string;
      wompiSourceId: number;
      tokens: AcceptanceTokens;
      integrityKey: string;
      pollAttempts: number;
      installments?: number;
    },
  ): Promise<ChargeOutcome> {
    const { payment } = args;

    const signature = await getSignatureKey({
      reference: payment.reference,
      amountInCents: payment.amountInCents,
      currency: payment.currency,
      integrityKey: args.integrityKey,
    });

    const [chargeError, transaction] = await this.client.transactions.createTransaction({
      acceptance_token: args.tokens.acceptanceToken,
      accept_personal_auth: args.tokens.personalAuthToken,
      amount_in_cents: payment.amountInCents,
      currency: payment.currency,
      signature,
      customer_email: args.customerEmail,
      payment_source_id: args.wompiSourceId,
      // Wompi requires installments when charging a saved card source.
      payment_method: { installments: args.installments ?? 1 },
      reference: payment.reference,
    });

    if (chargeError) {
      // A duplicate-reference rejection means a previous attempt actually
      // reached Wompi (e.g. a crashed run). Reconcile instead of failing.
      if (chargeError instanceof WompiValidationError && this.privateKey) {
        const [listError, existing] = await this.client.transactions.listTransactions({
          reference: payment.reference,
        });
        if (!listError && existing.length > 0) {
          return await this.applyWompiTransaction(ctx, pickTransaction(existing));
        }
      }

      if (chargeMayHaveReachedWompi(chargeError)) {
        // Wompi may hold a transaction we never saw (timeout, 5xx, network).
        // Recording a terminal `error` now would let the next attempt charge
        // under a fresh reference — a double charge. Leave the row pending:
        // the next claim reuses this reference (Wompi rejects the duplicate
        // and we reconcile), and the sweep reconciles by reference meanwhile.
        return {
          outcome: "unresolved",
          paymentChanged: false,
          subscriptionChanged: false,
          payment,
          subscription: null,
          note: chargeError.message,
        };
      }

      const outcome = (await ctx.runMutation(this.component.billing.recordChargeResult, {
        paymentId: payment._id,
        nextStatus: "error",
        failureReason: chargeError.message,
        config: this.billingConfig,
      })) as ChargeOutcome;
      await this.dispatch(ctx, outcome);
      return outcome;
    }

    let resolved = transaction;
    for (let i = 0; i < args.pollAttempts && resolved.status === "PENDING"; i++) {
      await sleep(this.billingOptions.pollIntervalMs);
      const [pollError, polled] = await this.client.transactions.getTransaction(
        transaction.id,
      );
      if (pollError) break;
      resolved = polled;
    }

    return await this.applyWompiTransaction(ctx, resolved);
  }

  async getCurrentSubscription(
    ctx: RunQueryCtx,
    args: { userId: string; productKey?: string },
  ): Promise<SubscriptionWithProduct | null> {
    return (await ctx.runQuery(this.component.subscriptions.getCurrent, {
      userId: args.userId,
      productKey: args.productKey,
    })) as SubscriptionWithProduct | null;
  }

  async listSubscriptions(ctx: RunQueryCtx, args: { userId: string }) {
    return await ctx.runQuery(this.component.subscriptions.listByUser, {
      userId: args.userId,
    });
  }

  async listPayments(ctx: RunQueryCtx, args: { userId: string; limit?: number }) {
    return await ctx.runQuery(this.component.payments.listByUser, {
      userId: args.userId,
      limit: args.limit,
    });
  }

  async cancelSubscription(
    ctx: RunMutationCtx,
    args: { userId: string; subscriptionId: string; immediately?: boolean },
  ): Promise<SubscriptionDoc> {
    const { subscription, changed } = (await ctx.runMutation(
      this.component.subscriptions.cancel,
      {
        subscriptionId: args.subscriptionId as never,
        userId: args.userId,
        immediately: args.immediately,
      },
    )) as { subscription: SubscriptionDoc; changed: boolean };

    // Canceling an already-canceled (or already pending-cancel) subscription
    // is a no-op — callbacks fire exactly once per real state change.
    if (changed) {
      await this.dispatch(ctx, {
        outcome: "applied",
        paymentChanged: false,
        subscriptionChanged: true,
        payment: null,
        subscription,
      });
    }
    return subscription;
  }

  async resumeSubscription(
    ctx: RunMutationCtx,
    args: { userId: string; subscriptionId: string },
  ): Promise<SubscriptionDoc> {
    const subscription = (await ctx.runMutation(this.component.subscriptions.resume, {
      subscriptionId: args.subscriptionId as never,
      userId: args.userId,
    })) as SubscriptionDoc;

    await this.dispatch(ctx, {
      outcome: "applied",
      paymentChanged: false,
      subscriptionChanged: true,
      payment: null,
      subscription,
    });
    return subscription;
  }

  async changeSubscription(
    ctx: RunMutationCtx,
    args: { userId: string; subscriptionId: string; productKey: string },
  ): Promise<SubscriptionDoc> {
    const { subscription, changed } = (await ctx.runMutation(
      this.component.subscriptions.changeProduct,
      {
        subscriptionId: args.subscriptionId as never,
        userId: args.userId,
        productKey: args.productKey,
      },
    )) as { subscription: SubscriptionDoc; changed: boolean };

    // A scheduled plan change patches the subscription, so it counts as a
    // state change; re-requesting the same pending product does not.
    if (changed) {
      await this.dispatch(ctx, {
        outcome: "applied",
        paymentChanged: false,
        subscriptionChanged: true,
        payment: null,
        subscription,
      });
    }
    return subscription;
  }

  // -------------------------------------------------------------------------
  // Billing engine
  // -------------------------------------------------------------------------

  /**
   * One full billing run: claim and charge due renewals, trial conversions
   * and dunning retries; finalize cancel-at-period-end subscriptions;
   * reconcile or expire stale pending payments; prune the webhook event log.
   *
   * Drive it from a cron via {@link billing}, or call it directly (tests,
   * manual runs, demos).
   */
  async processBilling(
    ctx: ActionCtx,
    options?: { batchSize?: number },
  ): Promise<ProcessBillingSummary> {
    const summary: ProcessBillingSummary = {
      claimed: 0,
      approved: 0,
      declined: 0,
      stillPending: 0,
      reconciled: 0,
      finalizedCancellations: 0,
      sweptPending: 0,
      expired: 0,
      errors: [],
    };

    const { claims, finalized } = (await ctx.runMutation(this.component.billing.claimDue, {
      batchSize: options?.batchSize,
      config: this.billingConfig,
    })) as {
      claims: {
        payment: PaymentDoc;
        subscription: SubscriptionDoc;
        customerEmail: string;
        wompiSourceId: number;
        action: "charge" | "reconcile";
      }[];
      finalized: SubscriptionDoc[];
    };

    summary.claimed = claims.length;
    summary.finalizedCancellations = finalized.length;

    for (const subscription of finalized) {
      await this.dispatch(ctx, {
        outcome: "applied",
        paymentChanged: false,
        subscriptionChanged: true,
        payment: null,
        subscription,
      });
    }

    let tokens: AcceptanceTokens | null = null;

    if (claims.some((c) => c.action === "charge")) {
      this.requireKey(this.privateKey, "private key", "WOMPI_PRIVATE_KEY");
      const [merchantError, merchant] = await this.client.merchants.getMerchant();
      if (merchantError) {
        summary.errors.push(`merchant: ${merchantError.message}`);
      } else {
        tokens = acceptanceTokensFrom(merchant);
      }
    }

    for (const claim of claims) {
      try {
        let outcome: ChargeOutcome;

        if (claim.action === "reconcile" && claim.payment.wompiTransactionId) {
          const [error, transaction] = await this.client.transactions.getTransaction(
            claim.payment.wompiTransactionId,
          );
          if (error) {
            summary.errors.push(`${claim.payment.reference}: ${error.message}`);
            continue;
          }
          outcome = await this.applyWompiTransaction(ctx, transaction);
        } else {
          if (!tokens) {
            summary.errors.push(`${claim.payment.reference}: no acceptance token`);
            continue;
          }
          outcome = await this.chargeClaimedPayment(ctx, {
            payment: claim.payment,
            customerEmail: claim.customerEmail,
            wompiSourceId: claim.wompiSourceId,
            tokens,
            integrityKey: this.requireKey(
              this.integrityKey,
              "integrity key",
              "WOMPI_INTEGRITY_KEY",
            ),
            // Renewals are non-interactive: poll less, let webhooks/sweeps finish.
            pollAttempts: 2,
          });
        }

        if (claim.action === "reconcile") summary.reconciled++;
        if (outcome.outcome === "unresolved") {
          summary.errors.push(`${claim.payment.reference}: ${outcome.note ?? "charge unresolved"}`);
        }
        const status = outcome.payment?.status;
        if (status === "approved") summary.approved++;
        else if (status === "declined" || status === "error") summary.declined++;
        else summary.stillPending++;
      } catch (error) {
        summary.errors.push(
          `${claim.payment.reference}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Sweep stale pendings: reconcile the ones Wompi knows about, expire the
    // ones nothing will ever resolve.
    const stale = (await ctx.runQuery(this.component.payments.listStalePending, {
      olderThanMs: this.billingOptions.pendingSweepAfterMs,
      limit: 50,
    })) as PaymentDoc[];

    for (const payment of stale) {
      try {
        if (payment.wompiTransactionId) {
          const [error, transaction] = await this.client.transactions.getTransaction(
            payment.wompiTransactionId,
          );
          if (!error) {
            const outcome = await this.applyWompiTransaction(ctx, transaction);
            if (outcome.paymentChanged) summary.sweptPending++;
          }
          continue;
        }

        const age = Date.now() - payment._creationTime;
        const neverCharged =
          payment.kind === "checkout" ||
          (payment.kind === "subscription" && payment.periodStart === undefined);
        const shouldExpire = neverCharged && age > this.billingOptions.expirePendingAfterMs;

        // No transaction id here does not mean no transaction at Wompi: a
        // server-side charge may have landed after a timeout, and a checkout
        // may have been paid without the webhook or redirect reaching us. Ask
        // Wompi by reference — every sweep for server-side charges, and once
        // before giving up on a checkout.
        if (this.privateKey && (payment.kind === "subscription" || shouldExpire)) {
          const [error, existing] = await this.client.transactions.listTransactions({
            reference: payment.reference,
          });
          if (error) {
            summary.errors.push(`sweep ${payment.reference}: ${error.message}`);
            continue;
          }
          if (existing.length > 0) {
            const outcome = await this.applyWompiTransaction(ctx, pickTransaction(existing));
            if (outcome.paymentChanged) summary.sweptPending++;
            continue;
          }
        }

        if (shouldExpire) {
          const outcome = (await ctx.runMutation(this.component.billing.recordChargeResult, {
            paymentId: payment._id,
            nextStatus: "expired",
            failureReason: "Expired without a transaction",
            config: this.billingConfig,
          })) as ChargeOutcome;
          await this.dispatch(ctx, outcome);
          summary.expired++;
        }
      } catch (error) {
        summary.errors.push(
          `sweep ${payment.reference}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    await ctx.runMutation(this.component.webhooks.cleanup, {
      // Wompi event timestamps are in seconds.
      olderThanTimestamp: Math.floor(
        (Date.now() - this.billingOptions.eventRetentionMs) / 1000,
      ),
    });

    return summary;
  }

  /**
   * The internal action your cron drives:
   *
   * ```ts
   * // convex/billing.ts
   * export const run = wompi.billing();
   *
   * // convex/crons.ts
   * crons.interval("wompi billing", { minutes: 15 }, internal.billing.run, {});
   * ```
   */
  billing() {
    return internalActionGeneric({
      args: { batchSize: v.optional(v.number()) },
      returns: v.any(),
      handler: async (ctx, args) => {
        return await this.processBilling(ctx, { batchSize: args.batchSize });
      },
    });
  }

  // -------------------------------------------------------------------------
  // Dispersions (Pagos a Terceros)
  // -------------------------------------------------------------------------

  /**
   * Create a payout batch — bank accounts, BRE-B keys, or both mixed —
   * through the Payouts API and record it as a `dispersions` row, updated
   * reactively as payout webhooks land.
   *
   * Wompi rejects a reused `idempotencyKey` within 24 hours and re-recording
   * an already-tracked payout is a no-op, so a retried action never creates a
   * duplicate batch or row.
   */
  async createDispersion(
    ctx: RunMutationCtx,
    input: CreatePayoutInput,
    options: { idempotencyKey: string },
  ): Promise<{ result: CreatePayoutResult; dispersion: DispersionDoc }> {
    const [error, result] = await this.payoutsClient.createPayout(input, options);

    if (error) {
      // A consumed idempotency key can mean a previous attempt created the
      // batch at Wompi but died before recording it here. Recover only when
      // the reference query proves one matching payout that pays these very
      // beneficiaries; otherwise preserve the conflict so an unrelated batch
      // is never attached locally.
      const conflict =
        error instanceof WompiPayoutApiError &&
        (error.code === "EXC_022" || error.code === "EXC_032");
      const recovered = conflict ? await this.recoverDispersion(ctx, input) : null;
      if (!recovered) throw error;
      return recovered;
    }

    const dispersion = await this.recordDispersion(ctx, input, result.payoutId, result);
    return { result, dispersion };
  }

  /**
   * Look the batch up after an idempotency conflict and track it only when
   * reference, payment type, transaction count and amount identify exactly
   * one payout across every result page, and that payout's transaction
   * detail pays the attempted beneficiaries. References are reusable and a
   * key can be reused with a different payload, so neither the first result
   * nor a totals-only match is safe.
   */
  private async recoverDispersion(
    ctx: RunMutationCtx,
    input: CreatePayoutInput,
  ): Promise<{ result: CreatePayoutResult; dispersion: DispersionDoc } | null> {
    // BRE-B and mixed batches are created through `/v2/payouts`, and Wompi
    // documents no v2 collection or reference listing to find them again.
    // The `/v1` search below can never prove such a batch, so preserve the
    // conflict instead of querying the wrong collection.
    if (input.transactions.some((transaction) => transaction.key !== undefined)) {
      return null;
    }

    const expectedAmount = input.transactions.reduce((sum, transaction) => {
      return sum + transaction.amount;
    }, 0);
    const candidates = new Map<string, Payout>();

    const scanned = await this.scanPayoutPages(
      (page) => this.payoutsClient.listPayouts({ reference: input.reference, page }),
      (payout) => {
        if (
          payout.reference !== input.reference ||
          payout.paymentType !== input.paymentType ||
          payout.totalTransactions !== input.transactions.length ||
          payout.amountInCents !== expectedAmount
        ) {
          return;
        }
        candidates.set(payout.id, payout);
      },
    );
    if (!scanned) return null;

    if (candidates.size !== 1) return null;
    const [candidate] = candidates.values();
    if (!candidate) return null;
    if (!(await this.candidatePaysBeneficiaries(candidate.id, input))) return null;

    const result: CreatePayoutResult = {
      payoutId: candidate.id,
      transactions: candidate.totalTransactions,
    };
    const dispersion = await this.recordDispersion(ctx, input, candidate.id, result);
    return { result, dispersion };
  }

  /**
   * Walk every page of a payout listing, feeding each record to `visit`.
   * False when the complete result set cannot be proven — a page fails,
   * echoes a different page number, or omits pagination metadata — so the
   * caller preserves the original idempotency conflict.
   */
  private async scanPayoutPages<T>(
    fetchPage: (page: number) => Promise<Result<PayoutPage<T>>>,
    visit: (record: T) => void,
  ): Promise<boolean> {
    let pageNumber = 1;
    let totalPages = 1;

    while (pageNumber <= totalPages) {
      const [listError, page] = await fetchPage(pageNumber);
      if (listError) return false;

      for (const record of page.records) visit(record);

      if (page.page !== undefined && page.page !== pageNumber) return false;

      let advertisedPages: number;
      if (page.pages !== undefined) {
        advertisedPages = page.pages;
      } else if (
        page.total !== undefined &&
        page.total >= 0 &&
        page.limit !== undefined &&
        page.limit > 0
      ) {
        advertisedPages = Math.ceil(page.total / page.limit);
      } else {
        return false;
      }
      if (advertisedPages < pageNumber) return false;
      totalPages = Math.max(totalPages, advertisedPages);
      pageNumber += 1;
    }

    return true;
  }

  /**
   * True only when the candidate batch's transaction detail pays exactly the
   * attempted beneficiaries: every listed transaction matched one-to-one on
   * account number and amount. Listings may mask account numbers, so the
   * listed digits must be a suffix of the attempted account. Anything
   * unprovable — a failed listing, a missing account or amount, a listed
   * account matching several attempted ones — rejects the candidate.
   */
  private async candidatePaysBeneficiaries(
    payoutId: string,
    input: CreatePayoutInput,
  ): Promise<boolean> {
    const pending = new Map<string, { accountDigits: string; amount: number; count: number }>();
    for (const transaction of input.transactions) {
      const accountNumber = transaction.accountNumber;
      if (accountNumber === undefined) return false;
      const key = `${accountNumber}:${transaction.amount}`;
      const entry = pending.get(key);
      if (entry) {
        entry.count += 1;
      } else {
        pending.set(key, {
          accountDigits: accountNumber.replace(/\D/g, ""),
          amount: transaction.amount,
          count: 1,
        });
      }
    }

    let remaining = input.transactions.length;
    let provable = true;
    const seenTransactionIds = new Set<string>();

    const scanned = await this.scanPayoutPages(
      (page) => this.payoutsClient.listPayoutTransactions(payoutId, { page }),
      (transaction) => {
        if (!provable) return;
        // A transaction repeated across pages means the listing shifted mid-
        // scan; it cannot count twice, and the scan can no longer prove the
        // complete detail. A blank id cannot be told apart from any other
        // transaction, so it is just as unprovable.
        if (transaction.id === "" || seenTransactionIds.has(transaction.id)) {
          provable = false;
          return;
        }
        seenTransactionIds.add(transaction.id);
        const listedDigits = transaction.payeeInfo?.accountNumber?.replace(/\D/g, "") ?? "";
        const amount = transaction.amountInCents;
        if (listedDigits.length === 0 || amount === undefined) {
          provable = false;
          return;
        }
        const matches = [...pending.values()].filter((entry) => {
          return entry.count > 0 && entry.amount === amount && entry.accountDigits.endsWith(listedDigits);
        });
        const match = matches.length === 1 ? matches[0] : undefined;
        if (!match) {
          provable = false;
          return;
        }
        match.count -= 1;
        remaining -= 1;
      },
    );

    return scanned && provable && remaining === 0;
  }

  private async recordDispersion(
    ctx: RunMutationCtx,
    input: CreatePayoutInput,
    payoutId: string,
    result: CreatePayoutResult,
  ): Promise<DispersionDoc> {
    return (await ctx.runMutation(this.component.dispersions.record, {
      wompiPayoutId: payoutId,
      reference: input.reference,
      // The create response carries no status; every batch starts PENDING.
      status: "PENDING",
      paymentType: input.paymentType,
      transactionsTotal: result.transactions ?? input.transactions.length,
      transactionsSuccess: result.success ?? 0,
      transactionsFailed: result.failed ?? 0,
      amountInCents: input.transactions.reduce((sum, t) => sum + t.amount, 0),
    })) as DispersionDoc;
  }

  /**
   * Resolve a BRE-B key to its masked holder information, to confirm the
   * beneficiary before paying. Read-only passthrough to the Payouts API —
   * nothing is persisted.
   */
  async resolveBrebKey(keyValue: string, keyType?: BrebKeyType): Promise<BrebKeyResolution> {
    const [error, resolution] = await this.payoutsClient.resolveBrebKey(keyValue, keyType);
    if (error) throw error;
    return resolution;
  }

  async getDispersion(ctx: RunQueryCtx, args: { wompiPayoutId: string }) {
    return await ctx.runQuery(this.component.dispersions.get, {
      wompiPayoutId: args.wompiPayoutId,
    });
  }

  async listDispersions(ctx: RunQueryCtx, args?: { status?: string; limit?: number }) {
    return await ctx.runQuery(this.component.dispersions.list, {
      status: args?.status,
      limit: args?.limit,
    });
  }

  // -------------------------------------------------------------------------
  // Webhooks
  // -------------------------------------------------------------------------

  /**
   * Mount the Wompi events endpoints on your app's HTTP router. Point the
   * "Eventos" URL in the Wompi dashboard at
   * `https://<deployment>.convex.site/wompi/webhook` (sandbox and production
   * are configured separately there). If you use dispersions, also point the
   * events URL of the Payouts developers section at
   * `https://<deployment>.convex.site/wompi/payouts-webhook` — payout events
   * are signed with their own secret (`WOMPI_PAYOUTS_EVENTS_KEY`).
   *
   * Deliveries are checksum-verified, deduplicated, applied through the same
   * state machine as everything else, and then handed to your callbacks.
   */
  registerRoutes(
    http: HttpRouter,
    options?: {
      path?: string;
      /** Payouts events endpoint; only used with `payouts` credentials. */
      payoutsPath?: string;
      onEvent?: (ctx: RunMutationCtx, event: WebhookEvent) => void | Promise<void>;
    },
  ) {
    const path = options?.path ?? "/wompi/webhook";
    const payoutsPath = options?.payoutsPath ?? "/wompi/payouts-webhook";

    http.route({
      path,
      method: "POST",
      handler: httpActionGeneric(async (ctx, request) => {
        const eventsKey = this.requireKey(this.eventsKey, "events key", "WOMPI_EVENTS_KEY");
        const body = await request.text();

        const [error, event] = await verifyWebhookEvent(body, { eventsKey });
        if (error) {
          return new Response(JSON.stringify({ error: "Invalid signature" }), {
            status: 403,
            headers: { "Content-Type": "application/json" },
          });
        }

        const transaction = isTransactionUpdatedEvent(event)
          ? event.data.transaction
          : undefined;

        const delivery = (await ctx.runMutation(this.component.webhooks.recordEvent, {
          checksum: event.signature.checksum,
          eventType: event.event,
          environment: event.environment,
          timestamp: event.timestamp,
          sentAt: event.sent_at,
          transactionId: transaction?.id,
          reference: transaction?.reference,
        })) as { duplicate: boolean; eventId: string; outcome?: string };

        // A duplicate with no recorded outcome crashed between recording and
        // applying on a previous delivery; Wompi's retry must reprocess it,
        // not be told it was handled.
        if (delivery.duplicate && delivery.outcome !== undefined) {
          return new Response(JSON.stringify({ received: true, duplicate: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        const eventId = delivery.eventId;

        let outcome = "ignored";

        if (transaction) {
          const result = await this.applyWompiTransaction(ctx, transaction);
          outcome = result.outcome;
        }

        await ctx.runMutation(this.component.webhooks.markOutcome, {
          eventId: eventId as never,
          outcome,
        });

        try {
          await options?.onEvent?.(ctx, event);
        } catch (callbackError) {
          console.error("Wompi onEvent callback failed:", callbackError);
        }

        return new Response(JSON.stringify({ received: true, duplicate: delivery.duplicate }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    });

    http.route({
      path: payoutsPath,
      method: "POST",
      handler: httpActionGeneric(async (ctx, request) => {
        const eventsKey = this.requireKey(
          this.payoutsEventsKey,
          "payouts events key",
          "WOMPI_PAYOUTS_EVENTS_KEY",
        );
        const body = await request.text();

        const [error, event] = await verifyPayoutEvent(body, { eventsKey });
        if (error) {
          return new Response(JSON.stringify({ error: "Invalid signature" }), {
            status: 403,
            headers: { "Content-Type": "application/json" },
          });
        }

        const onDispersionChange = this.config.events?.onDispersionChange;
        const callbackHandle = onDispersionChange
          ? await createFunctionHandle(onDispersionChange)
          : undefined;
        let processed: { duplicate: boolean; outcome: string };

        if (isPayoutUpdatedEvent(event)) {
          const payout = event.data.payout;
          processed = (await ctx.runMutation(
            this.component.webhooks.processPayoutUpdate,
            {
              checksum: event.signature.checksum,
              eventType: event.event,
              timestamp: event.timestamp,
              sentAt: event.sentAt,
              callbackHandle,
              payout: {
                wompiPayoutId: payout.id,
                status: payout.status,
                reference: payout.reference,
                paymentType: payout.paymentType,
                transactionsTotal: payout.totalTransactions,
                amountInCents: payout.amountInCents,
              },
            },
          )) as { duplicate: boolean; outcome: string };
        } else if (isPayoutTransactionUpdatedEvent(event)) {
          const transaction = event.data.transaction;
          const failureReason = transaction.failureReason;
          processed = (await ctx.runMutation(
            this.component.webhooks.processPayoutTransactionUpdate,
            {
              checksum: event.signature.checksum,
              eventType: event.event,
              timestamp: event.timestamp,
              sentAt: event.sentAt,
              callbackHandle,
              transaction: {
                wompiPayoutId: transaction.payoutId,
                wompiTransactionId: transaction.id,
                status: transaction.status,
                amountInCents: transaction.amountInCents,
                reference:
                  typeof transaction.reference === "string" ? transaction.reference : undefined,
                payeeName: transaction.payee.name,
                payeeKey: transaction.payee.key,
                // Bank events word failures as `message`, BRE-B as `description`.
                failureReason:
                  typeof failureReason === "string"
                    ? failureReason
                    : (failureReason?.message ?? failureReason?.description),
              },
            },
          )) as { duplicate: boolean; outcome: string };
        } else {
          const delivery = (await ctx.runMutation(this.component.webhooks.recordEvent, {
            checksum: event.signature.checksum,
            eventType: event.event,
            timestamp: event.timestamp,
            sentAt: event.sentAt,
          })) as { duplicate: boolean; eventId: string; outcome?: string };
          if (delivery.outcome === undefined) {
            await ctx.runMutation(this.component.webhooks.markOutcome, {
              eventId: delivery.eventId as never,
              outcome: "ignored",
            });
          }
          processed = { duplicate: delivery.duplicate, outcome: delivery.outcome ?? "ignored" };
        }

        return new Response(JSON.stringify({ received: true, duplicate: processed.duplicate }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    });
  }

  // -------------------------------------------------------------------------
  // Prebuilt app API
  // -------------------------------------------------------------------------

  /**
   * Prebuilt public functions for one-line re-export from any module in your
   * `convex/` directory. Identity always comes from `getUserInfo` — never
   * from client arguments.
   *
   * ```ts
   * // convex/wompi.ts
   * export const {
   *   getConfig, listProducts, getCurrentSubscription, listPayments,
   *   getPayment, checkout, confirmTransaction, subscribe,
   *   cancelSubscription, resumeSubscription, changeSubscription,
   * } = wompi.api();
   * ```
   */
  api() {
    const getUser = (ctx: IdentityCtx) => this.config.getUserInfo(ctx);

    return {
      /** Safe-to-expose config the browser needs for tokenization. */
      getConfig: queryGeneric({
        args: {},
        returns: v.object({
          publicKey: v.string(),
          sandbox: v.boolean(),
          currency: v.string(),
        }),
        handler: async () => ({
          publicKey: this.publicKey,
          sandbox: this.sandbox,
          currency: "COP",
        }),
      }),

      listProducts: queryGeneric({
        args: {},
        handler: async (ctx) => await this.listProducts(ctx),
      }),

      getCurrentSubscription: queryGeneric({
        args: { productKey: v.optional(v.string()) },
        handler: async (ctx, args) => {
          const user = await getUser(ctx);
          return await this.getCurrentSubscription(ctx, {
            userId: user.userId,
            productKey: args.productKey,
          });
        },
      }),

      listSubscriptions: queryGeneric({
        args: {},
        handler: async (ctx) => {
          const user = await getUser(ctx);
          return await this.listSubscriptions(ctx, { userId: user.userId });
        },
      }),

      listPayments: queryGeneric({
        args: { limit: v.optional(v.number()) },
        handler: async (ctx, args) => {
          const user = await getUser(ctx);
          return await this.listPayments(ctx, { userId: user.userId, limit: args.limit });
        },
      }),

      getPayment: queryGeneric({
        args: { reference: v.string() },
        handler: async (ctx, args) => {
          const user = await getUser(ctx);
          const payment = (await ctx.runQuery(this.component.payments.getByReference, {
            reference: args.reference,
          })) as PaymentDoc | null;
          if (!payment || payment.userId !== user.userId) return null;
          return payment;
        },
      }),

      /**
       * Client-facing checkout: the amount always comes from the catalog
       * (`productKey`), never from the browser. Use `wompi.checkout(ctx, …)`
       * in your own server function for custom amounts or metadata.
       */
      checkout: actionGeneric({
        args: {
          redirectUrl: v.string(),
          productKey: v.string(),
        },
        returns: v.object({ url: v.string(), reference: v.string() }),
        handler: async (ctx, args) => {
          const { url, reference } = await this.checkout(ctx, {
            redirectUrl: args.redirectUrl,
            productKey: args.productKey,
          });
          return { url, reference };
        },
      }),

      /**
       * Redirect-return confirmation for the signed-in user. Rows that belong
       * to someone else (or to nobody the component knows) only reveal the
       * outcome code, never the payment.
       */
      confirmTransaction: actionGeneric({
        args: { transactionId: v.string() },
        handler: async (ctx, args): Promise<ChargeOutcome> => {
          const user = await getUser(ctx);
          const outcome = await this.confirmTransaction(ctx, {
            transactionId: args.transactionId,
          });
          if (outcome.payment && outcome.payment.userId === user.userId) return outcome;
          return {
            outcome: outcome.outcome,
            paymentChanged: false,
            subscriptionChanged: false,
            payment: null,
            subscription: null,
          };
        },
      }),

      subscribe: actionGeneric({
        args: {
          productKey: v.string(),
          token: v.string(),
          installments: v.optional(v.number()),
          type: v.optional(v.union(v.literal("CARD"), v.literal("NEQUI"))),
          paymentMethod: v.optional(
            v.object({
              brand: v.optional(v.string()),
              lastFour: v.optional(v.string()),
              expMonth: v.optional(v.string()),
              expYear: v.optional(v.string()),
              cardHolder: v.optional(v.string()),
            }),
          ),
          metadata: v.optional(v.record(v.string(), v.any())),
        },
        handler: async (ctx, args) => {
          const { subscription, payment } = await this.subscribe(ctx, args);
          return { subscription, payment };
        },
      }),

      cancelSubscription: mutationGeneric({
        args: { subscriptionId: v.string(), immediately: v.optional(v.boolean()) },
        handler: async (ctx, args) => {
          const user = await getUser(ctx);
          return await this.cancelSubscription(ctx, {
            userId: user.userId,
            subscriptionId: args.subscriptionId,
            immediately: args.immediately,
          });
        },
      }),

      resumeSubscription: mutationGeneric({
        args: { subscriptionId: v.string() },
        handler: async (ctx, args) => {
          const user = await getUser(ctx);
          return await this.resumeSubscription(ctx, {
            userId: user.userId,
            subscriptionId: args.subscriptionId,
          });
        },
      }),

      changeSubscription: mutationGeneric({
        args: { subscriptionId: v.string(), productKey: v.string() },
        handler: async (ctx, args) => {
          const user = await getUser(ctx);
          return await this.changeSubscription(ctx, {
            userId: user.userId,
            subscriptionId: args.subscriptionId,
            productKey: args.productKey,
          });
        },
      }),
    };
  }
}

/**
 * Type of the API produced by `wompi.api()`, for typing React helpers:
 * `Pick<WompiApi, "getConfig" | "subscribe">` etc.
 */
export type WompiApi = ApiFromModules<{
  wompi: ReturnType<Wompi["api"]>;
}>["wompi"];
