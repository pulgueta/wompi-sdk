import { v } from "convex/values";
import { mutation } from "./_generated/server.js";
import type { MutationCtx } from "./_generated/server.js";
import type { Doc } from "./_generated/dataModel.js";
import {
  addInterval,
  billingConfigValidator,
  CHARGEABLE_STATUSES,
  paymentDoc,
  retryDelayMs,
  subscriptionChargeReference,
  subscriptionDoc,
  WOMPI_STATUS_TO_PAYMENT_STATUS,
} from "./shared.js";
import type { BillingConfig, PaymentStatus } from "./shared.js";

export const chargeOutcomeValidator = v.object({
  outcome: v.string(),
  paymentChanged: v.boolean(),
  subscriptionChanged: v.boolean(),
  payment: v.union(paymentDoc, v.null()),
  subscription: v.union(subscriptionDoc, v.null()),
  note: v.optional(v.string()),
});

/** Settled statuses a later APPROVED/VOIDED transaction may still move. */
const REOPENABLE_STATUSES: PaymentStatus[] = ["declined", "error", "expired"];

type ChargeOutcomeInput = {
  nextStatus: PaymentStatus;
  wompiTransactionId?: string;
  paymentMethodType?: string;
  failureReason?: string;
};

/**
 * The single state machine every charge result flows through — webhook
 * deliveries, redirect-return reconciliation and cron charges all converge
 * here, which is what makes the whole engine idempotent.
 */
const applyChargeOutcome = async (
  ctx: MutationCtx,
  payment: Doc<"payments">,
  input: ChargeOutcomeInput,
  config: BillingConfig,
) => {
  const now = Date.now();
  const next = input.nextStatus;

  // Allowed transitions. A failed or expired attempt may still end approved
  // (or voided) later: Web Checkout lets the payer retry a declined payment
  // within minutes under the same reference, and late webhooks can land
  // after the sweep expired an abandoned checkout.
  const statusChanges =
    payment.status !== next &&
    (payment.status === "pending" ||
      (REOPENABLE_STATUSES.includes(payment.status) &&
        (next === "approved" || next === "voided")) ||
      (payment.status === "approved" && next === "voided"));

  const patch: Partial<Doc<"payments">> = {};
  if (statusChanges) {
    patch.status = next;
    if (next !== "pending") patch.finalizedAt = now;
    if (input.failureReason) patch.failureReason = input.failureReason;
    if (next === "approved") patch.failureReason = undefined;
  }
  if (input.wompiTransactionId && input.wompiTransactionId !== payment.wompiTransactionId) {
    if (!payment.wompiTransactionId) {
      patch.wompiTransactionId = input.wompiTransactionId;
    } else if (statusChanges) {
      // A different Wompi transaction resolved this reference (payer retry):
      // track the new one and keep the previous id for audit.
      patch.wompiTransactionId = input.wompiTransactionId;
      patch.supersededTransactionIds = [
        ...(payment.supersededTransactionIds ?? []),
        payment.wompiTransactionId,
      ];
    }
  }
  if (input.paymentMethodType && (!payment.paymentMethodType || statusChanges)) {
    patch.paymentMethodType = input.paymentMethodType;
  }

  if (Object.keys(patch).length > 0) {
    await ctx.db.patch("payments", payment._id, patch);
  }

  const updatedPayment = (await ctx.db.get("payments", payment._id))!;

  let subscription: Doc<"subscriptions"> | null = null;
  let subscriptionChanged = false;
  let note: string | undefined;

  if (payment.subscriptionId) {
    subscription = await ctx.db.get("subscriptions", payment.subscriptionId);
  }

  if (statusChanges && subscription) {
    if (next === "approved") {
      if (subscription.status === "canceled") {
        // A charge landed after the subscription was canceled — don't
        // resurrect it; surface so the app can refund manually.
        note = "approved_after_canceled";
      } else {
        const periodStart = updatedPayment.periodStart ?? now;
        const periodEnd =
          updatedPayment.periodEnd ??
          addInterval(periodStart, subscription.interval, subscription.intervalCount);

        await ctx.db.patch("subscriptions", subscription._id, {
          status: "active",
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
          nextChargeAt: periodEnd,
          failedAttempts: 0,
          lastError: undefined,
        });
        subscriptionChanged = true;
      }
    } else if (next === "declined" || next === "error") {
      const reason = input.failureReason ?? `Charge ${next}`;

      if (subscription.status === "incomplete" || subscription.status === "unpaid") {
        // Interactive attempts (first charge / recovery) are not retried by
        // the cron — the user is in front of the form.
        await ctx.db.patch("subscriptions", subscription._id, { lastError: reason });
        subscriptionChanged = true;
      } else if (CHARGEABLE_STATUSES.includes(subscription.status)) {
        const attempts = subscription.failedAttempts + 1;

        if (attempts > config.maxRetries) {
          if (config.onExhausted === "cancel") {
            await ctx.db.patch("subscriptions", subscription._id, {
              status: "canceled",
              canceledAt: subscription.canceledAt ?? now,
              endedAt: now,
              nextChargeAt: undefined,
              failedAttempts: attempts,
              lastError: reason,
            });
          } else {
            await ctx.db.patch("subscriptions", subscription._id, {
              status: "unpaid",
              nextChargeAt: undefined,
              failedAttempts: attempts,
              lastError: reason,
            });
          }
        } else {
          await ctx.db.patch("subscriptions", subscription._id, {
            status: "past_due",
            failedAttempts: attempts,
            nextChargeAt: now + retryDelayMs(config, attempts),
            lastError: reason,
          });
        }
        subscriptionChanged = true;
      }
    } else if (next === "voided") {
      note = "voided_subscription_payment";
    }

    subscription = await ctx.db.get("subscriptions", payment.subscriptionId!);
  }

  return {
    outcome: statusChanges ? "applied" : "noop",
    paymentChanged: statusChanges,
    subscriptionChanged,
    payment: updatedPayment,
    subscription,
    note,
  };
};

export const claimValidator = v.object({
  subscription: subscriptionDoc,
  payment: paymentDoc,
  customerEmail: v.string(),
  wompiSourceId: v.number(),
  action: v.union(v.literal("charge"), v.literal("reconcile")),
});

/**
 * Atomically claim everything the billing run must act on: renewals, trial
 * conversions and dunning retries become leased charge claims (with a
 * deterministic reference, so a crashed run can never double-charge);
 * subscriptions past their cancel-at-period-end date are finalized.
 */
export const claimDue = mutation({
  args: {
    batchSize: v.optional(v.number()),
    config: billingConfigValidator,
  },
  returns: v.object({
    claims: v.array(claimValidator),
    finalized: v.array(subscriptionDoc),
  }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const batchSize = Math.min(args.batchSize ?? 25, 100);

    const due = await ctx.db
      .query("subscriptions")
      .withIndex("by_next_charge_at", (q) => q.gt("nextChargeAt", 0).lte("nextChargeAt", now))
      .take(batchSize);

    const claims = [];
    const finalized = [];

    for (let subscription of due) {
      if (!CHARGEABLE_STATUSES.includes(subscription.status)) {
        await ctx.db.patch("subscriptions", subscription._id, { nextChargeAt: undefined });
        continue;
      }

      if (subscription.cancelAtPeriodEnd && now >= subscription.currentPeriodEnd) {
        await ctx.db.patch("subscriptions", subscription._id, {
          status: "canceled",
          endedAt: subscription.currentPeriodEnd,
          canceledAt: subscription.canceledAt ?? now,
          nextChargeAt: undefined,
        });
        finalized.push((await ctx.db.get("subscriptions", subscription._id))!);
        continue;
      }

      if (subscription.pendingProductId) {
        const pending = await ctx.db.get("products", subscription.pendingProductId);
        if (pending && pending.active && pending.type === "subscription" && pending.interval) {
          await ctx.db.patch("subscriptions", subscription._id, {
            productId: pending._id,
            productKey: pending.key,
            amountInCents: pending.amountInCents,
            currency: pending.currency,
            interval: pending.interval,
            intervalCount: pending.intervalCount ?? 1,
            pendingProductId: undefined,
            pendingProductKey: undefined,
          });
        } else {
          await ctx.db.patch("subscriptions", subscription._id, {
            pendingProductId: undefined,
            pendingProductKey: undefined,
          });
        }
        subscription = (await ctx.db.get("subscriptions", subscription._id))!;
      }

      const customer = await ctx.db.get("customers", subscription.customerId);
      const paymentSource = await ctx.db.get("paymentSources", subscription.paymentSourceId);

      if (!customer || !paymentSource || paymentSource.status !== "AVAILABLE") {
        // Nothing to charge against: run the failure path directly so
        // dunning (and eventually expiry) still progresses.
        const reference = subscriptionChargeReference(
          subscription._id,
          subscription.currentPeriodEnd,
          subscription.failedAttempts,
        );
        const existing = await ctx.db
          .query("payments")
          .withIndex("by_reference", (q) => q.eq("reference", reference))
          .unique();

        const paymentId =
          existing?._id ??
          (await ctx.db.insert("payments", {
            reference,
            kind: "subscription",
            status: "pending",
            customerId: subscription.customerId,
            userId: subscription.userId,
            productId: subscription.productId,
            productKey: subscription.productKey,
            subscriptionId: subscription._id,
            amountInCents: subscription.amountInCents,
            currency: subscription.currency,
            attempt: subscription.failedAttempts,
            periodStart: subscription.currentPeriodEnd,
            periodEnd: addInterval(
              subscription.currentPeriodEnd,
              subscription.interval,
              subscription.intervalCount,
            ),
          }));

        const payment = (await ctx.db.get("payments", paymentId))!;
        await applyChargeOutcome(
          ctx,
          payment,
          { nextStatus: "error", failureReason: "Payment source unavailable" },
          args.config,
        );
        continue;
      }

      const reference = subscriptionChargeReference(
        subscription._id,
        subscription.currentPeriodEnd,
        subscription.failedAttempts,
      );

      const existing = await ctx.db
        .query("payments")
        .withIndex("by_reference", (q) => q.eq("reference", reference))
        .unique();

      let payment: Doc<"payments">;

      if (existing) {
        if (existing.status !== "pending") {
          // Already resolved — the subscription transition happened in the
          // same mutation that resolved it. Nothing to do this round.
          await ctx.db.patch("subscriptions", subscription._id, { nextChargeAt: undefined });
          continue;
        }
        payment = existing;
      } else {
        const product = await ctx.db.get("products", subscription.productId);
        const periodStart = subscription.currentPeriodEnd;
        const paymentId = await ctx.db.insert("payments", {
          reference,
          kind: "subscription",
          status: "pending",
          customerId: subscription.customerId,
          userId: subscription.userId,
          productId: subscription.productId,
          productKey: subscription.productKey,
          subscriptionId: subscription._id,
          amountInCents: subscription.amountInCents,
          currency: subscription.currency,
          description: product?.name ?? subscription.productKey,
          attempt: subscription.failedAttempts,
          periodStart,
          periodEnd: addInterval(periodStart, subscription.interval, subscription.intervalCount),
        });
        payment = (await ctx.db.get("payments", paymentId))!;
      }

      await ctx.db.patch("subscriptions", subscription._id, { nextChargeAt: now + args.config.leaseMs });

      claims.push({
        subscription: (await ctx.db.get("subscriptions", subscription._id))!,
        payment,
        customerEmail: customer.email,
        wompiSourceId: paymentSource.wompiSourceId,
        action: payment.wompiTransactionId ? ("reconcile" as const) : ("charge" as const),
      });
    }

    return { claims, finalized };
  },
});

/** Record the result of a charge the billing action just attempted. */
export const recordChargeResult = mutation({
  args: {
    paymentId: v.id("payments"),
    nextStatus: v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("declined"),
      v.literal("voided"),
      v.literal("error"),
      v.literal("expired"),
    ),
    wompiTransactionId: v.optional(v.string()),
    paymentMethodType: v.optional(v.string()),
    failureReason: v.optional(v.string()),
    config: billingConfigValidator,
  },
  returns: chargeOutcomeValidator,
  handler: async (ctx, args) => {
    const payment = await ctx.db.get("payments", args.paymentId);
    if (!payment) {
      return {
        outcome: "unknown_payment",
        paymentChanged: false,
        subscriptionChanged: false,
        payment: null,
        subscription: null,
      };
    }

    return await applyChargeOutcome(
      ctx,
      payment,
      {
        nextStatus: args.nextStatus,
        wompiTransactionId: args.wompiTransactionId,
        paymentMethodType: args.paymentMethodType,
        failureReason: args.failureReason,
      },
      args.config,
    );
  },
});

/**
 * Apply a Wompi transaction (from a verified webhook or an API fetch) to the
 * payment row its reference points at. Unknown references are ignored —
 * merchants can have non-component transactions on the same account. The
 * amount/currency guard stops the classic forged-checkout attack: anyone
 * holding the public key can create their own 1-cent transaction reusing a
 * component reference.
 */
export const applyTransaction = mutation({
  args: {
    reference: v.string(),
    wompiTransactionId: v.string(),
    wompiStatus: v.string(),
    amountInCents: v.optional(v.number()),
    currency: v.optional(v.string()),
    paymentMethodType: v.optional(v.string()),
    statusMessage: v.optional(v.string()),
    config: billingConfigValidator,
  },
  returns: chargeOutcomeValidator,
  handler: async (ctx, args) => {
    const payment = await ctx.db
      .query("payments")
      .withIndex("by_reference", (q) => q.eq("reference", args.reference))
      .unique();

    if (!payment) {
      return {
        outcome: "unknown_reference",
        paymentChanged: false,
        subscriptionChanged: false,
        payment: null,
        subscription: null,
      };
    }

    const nextStatus = WOMPI_STATUS_TO_PAYMENT_STATUS[args.wompiStatus];
    if (!nextStatus) {
      return {
        outcome: "unknown_status",
        paymentChanged: false,
        subscriptionChanged: false,
        payment,
        subscription: null,
        note: `Unrecognized Wompi status "${args.wompiStatus}"`,
      };
    }

    if (
      (args.amountInCents !== undefined && args.amountInCents !== payment.amountInCents) ||
      (args.currency !== undefined && args.currency !== payment.currency)
    ) {
      return {
        outcome: "amount_mismatch",
        paymentChanged: false,
        subscriptionChanged: false,
        payment,
        subscription: null,
        note: `Transaction ${args.wompiTransactionId} reports ${args.amountInCents} ${args.currency}, payment expects ${payment.amountInCents} ${payment.currency}`,
      };
    }

    return await applyChargeOutcome(
      ctx,
      payment,
      {
        nextStatus,
        wompiTransactionId: args.wompiTransactionId,
        paymentMethodType: args.paymentMethodType,
        failureReason:
          nextStatus === "declined" || nextStatus === "error" ? args.statusMessage : undefined,
      },
      args.config,
    );
  },
});
