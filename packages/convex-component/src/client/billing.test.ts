/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { FunctionReference } from "convex/server";
import { computeEventChecksum } from "@pulgueta/wompi/server";
import type { ChargeOutcome, WompiConfig } from "./index.js";
import { Wompi } from "./index.js";
import { components, initConvexTest } from "./setup.test.js";

const EVENTS_KEY = "test_events_key";
const REFERENCE_USED = {
  error: {
    type: "INPUT_VALIDATION_ERROR",
    messages: { reference: ["La referencia ya ha sido usada"] },
  },
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const merchant = () =>
  json({
    data: {
      id: 1,
      presigned_acceptance: {
        acceptance_token: "acc_token",
        permalink: "https://wompi.co/terms.pdf",
        type: "END_USER_POLICY",
      },
      presigned_personal_data_auth: {
        acceptance_token: "personal_token",
        permalink: "https://wompi.co/personal-data.pdf",
        type: "PERSONAL_DATA_AUTH",
      },
    },
  });

const transaction = (id: string, status: string, reference: string, amount = 2_990_000) => ({
  id,
  status,
  reference,
  amount_in_cents: amount,
  currency: "COP",
  payment_method_type: "CARD",
  created_at: "2026-08-18T10:00:00.000Z",
});

type Route = {
  method: string;
  path: RegExp;
  respond: (init?: RequestInit) => Response | Promise<Response>;
};

/** Route-based fetch mock so each test declares the Wompi API it expects. */
const routeFetch = (routes: Route[]) =>
  vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const route = routes.find((r) => r.method === method && r.path.test(url));
    if (!route) throw new Error(`Unexpected fetch ${method} ${url}`);
    return await route.respond(init);
  });

const CARD = {
  wompiSourceId: 1234,
  type: "CARD",
  status: "AVAILABLE",
  brand: "VISA",
  lastFour: "4242",
};

const makeWompi = (overrides: Partial<WompiConfig> = {}) =>
  new Wompi(components.wompi, {
    getUserInfo: async () => ({ userId: "user_1", email: "ada@example.com" }),
    publicKey: "pub_test_key",
    privateKey: "prv_test_key",
    eventsKey: EVENTS_KEY,
    integrityKey: "integrity_key",
    sandbox: true,
    billing: {
      leaseMs: 0,
      pollAttempts: 1,
      pollIntervalMs: 0,
      pendingSweepAfterMs: 0,
    },
    ...overrides,
  });

async function seed(t: ReturnType<typeof initConvexTest>) {
  const customer = await t.mutation(components.wompi.customers.upsert, {
    userId: "user_1",
    email: "ada@example.com",
  });
  await t.mutation(components.wompi.products.sync, {
    products: [
      {
        key: "pro-monthly",
        name: "Pro",
        type: "subscription" as const,
        amountInCents: 2_990_000,
        interval: "month" as const,
      },
      {
        key: "sticker-pack",
        name: "Sticker pack",
        type: "one_time" as const,
        amountInCents: 500_000,
      },
    ],
  });
  return { customer };
}

/** An active subscription whose renewal is due now. */
async function dueRenewal(t: ReturnType<typeof initConvexTest>) {
  const { customer } = await seed(t);
  const created = await t.mutation(components.wompi.subscriptions.create, {
    customerId: customer._id,
    userId: "user_1",
    productKey: "pro-monthly",
    paymentSource: CARD,
  });
  await t.mutation(components.wompi.billing.recordChargeResult, {
    paymentId: created.payment!._id,
    nextStatus: "approved",
    wompiTransactionId: "tx_init",
    config: {
      maxRetries: 3,
      retryScheduleMs: [1_000],
      onExhausted: "mark_unpaid",
      leaseMs: 0,
    },
  });
  await t.mutation(components.wompi.subscriptions.setNextChargeAt, {
    subscriptionId: created.subscription._id,
    at: Date.now() - 1_000,
  });
  return created.subscription;
}

// Component tables live in the component's own database, so read them back
// through the component's queries rather than `t.run`.
const paymentsOf = async (t: ReturnType<typeof initConvexTest>, subscriptionId: string) =>
  (await t.query(components.wompi.payments.listByUser, { userId: "user_1" })).filter(
    (p) => p.subscriptionId === subscriptionId,
  );

const subscriptionOf = (t: ReturnType<typeof initConvexTest>, subscriptionId: string) =>
  t.query(components.wompi.subscriptions.get, {
    subscriptionId: subscriptionId as never,
  });

describe("renewal charge idempotency", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("a transport error leaves the payment pending and the next claim reconciles by reference", async () => {
    const t = initConvexTest();
    const subscription = await dueRenewal(t);

    const posted: string[] = [];
    let lookups = 0;
    // The first request reaches Wompi but its response never comes back;
    // Wompi only exposes the resulting transaction a little later.
    let wompiSide: ReturnType<typeof transaction> | null = null;
    let listable = false;
    const fetchMock = routeFetch([
      { method: "GET", path: /\/merchants\//, respond: () => merchant() },
      {
        method: "POST",
        path: /\/transactions$/,
        respond: (init) => {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          posted.push(body.reference as string);
          expect(body.acceptance_token).toBe("acc_token");
          expect(body.accept_personal_auth).toBe("personal_token");
          if (wompiSide === null) {
            wompiSide = transaction("tx_renewal", "APPROVED", body.reference as string);
            throw new TypeError("fetch failed");
          }
          return json(REFERENCE_USED, 422);
        },
      },
      {
        method: "GET",
        path: /\/transactions\?reference=/,
        respond: () => {
          lookups++;
          return json({ data: listable && wompiSide ? [wompiSide] : [] });
        },
      },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const changes: string[] = [];
    const wompiWithEvents = makeWompi({
      events: {
        onPaymentChange: async (_ctx, payment) => {
          changes.push(payment.status);
        },
      },
    });

    const first = await t.action(async (ctx) => await wompiWithEvents.processBilling(ctx));
    expect(first.claimed).toBe(1);
    expect(first.stillPending).toBe(1);
    expect(first.declined).toBe(0);
    expect(first.errors).toHaveLength(1);
    expect(first.errors[0]).toContain("status 0");
    // The sweep already asked Wompi about the reference in the same run.
    expect(lookups).toBe(1);
    listable = true;

    let payments = await paymentsOf(t, subscription._id);
    const renewal = payments.find((p) => p.reference.endsWith("_a0") && p.periodStart);
    expect(renewal?.status).toBe("pending");
    expect(renewal?.wompiTransactionId).toBeUndefined();

    // Nothing was finalized, so no callback fired and the subscription is
    // untouched (no dunning step, no fresh reference).
    expect(changes).toEqual([]);
    const sub = await subscriptionOf(t, subscription._id);
    expect(sub?.status).toBe("active");
    expect(sub?.failedAttempts).toBe(0);

    // Lease expired (leaseMs 0): the next run re-claims the SAME reference,
    // Wompi rejects the duplicate, and the existing transaction is applied.
    const second = await t.action(async (ctx) => await wompiWithEvents.processBilling(ctx));
    expect(second.claimed).toBe(1);
    expect(second.approved).toBe(1);
    expect(second.errors).toEqual([]);

    payments = await paymentsOf(t, subscription._id);
    const settled = payments.find((p) => p._id === renewal!._id);
    expect(settled?.status).toBe("approved");
    expect(settled?.wompiTransactionId).toBe("tx_renewal");
    expect(payments.filter((p) => p.status === "pending")).toHaveLength(0);
    expect(posted).toEqual([renewal!.reference, renewal!.reference]);
    expect(changes).toEqual(["approved"]);
  });

  test("a rejected request (4xx) finalizes the attempt as an error", async () => {
    const t = initConvexTest();
    const subscription = await dueRenewal(t);
    const wompi = makeWompi();

    vi.stubGlobal(
      "fetch",
      routeFetch([
        { method: "GET", path: /\/merchants\//, respond: () => merchant() },
        {
          method: "POST",
          path: /\/transactions$/,
          respond: () => json({ error: { type: "UNAUTHORIZED", reason: "bad key" } }, 401),
        },
        {
          method: "GET",
          path: /\/transactions\?reference=/,
          respond: () => json({ data: [] }),
        },
      ]),
    );

    const summary = await t.action(async (ctx) => await wompi.processBilling(ctx));
    expect(summary.declined).toBe(1);

    const payments = await paymentsOf(t, subscription._id);
    const renewal = payments.find((p) => p.periodStart);
    expect(renewal?.status).toBe("error");
    const sub = await subscriptionOf(t, subscription._id);
    expect(sub?.status).toBe("past_due");
    expect(sub?.failedAttempts).toBe(1);
  });

  test("a duplicate-reference rejection whose lookup fails leaves the payment pending", async () => {
    const t = initConvexTest();
    const subscription = await dueRenewal(t);
    const wompi = makeWompi();

    let lookups = 0;
    vi.stubGlobal(
      "fetch",
      routeFetch([
        { method: "GET", path: /\/merchants\//, respond: () => merchant() },
        {
          method: "POST",
          path: /\/transactions$/,
          respond: () => json(REFERENCE_USED, 422),
        },
        {
          method: "GET",
          path: /\/transactions\?reference=/,
          respond: () => {
            lookups++;
            return json({ error: { type: "INTERNAL", reason: "try later" } }, 503);
          },
        },
      ]),
    );

    // Wompi holds a transaction for this reference (it rejected the
    // duplicate) but cannot list it right now: the row must stay pending so
    // the sweep reconciles it later, not be finalized as `error`.
    const summary = await t.action(async (ctx) => await wompi.processBilling(ctx));
    expect(summary.stillPending).toBe(1);
    expect(summary.declined).toBe(0);
    expect(lookups).toBeGreaterThanOrEqual(1);

    const payments = await paymentsOf(t, subscription._id);
    const renewal = payments.find((p) => p.periodStart);
    expect(renewal?.status).toBe("pending");
    const sub = await subscriptionOf(t, subscription._id);
    expect(sub?.status).toBe("active");
    expect(sub?.failedAttempts).toBe(0);
  });

  test("a newer terminal transaction outranks an older pending one for the same reference", async () => {
    const t = initConvexTest();
    const subscription = await dueRenewal(t);
    const wompi = makeWompi();

    let reference = "";
    vi.stubGlobal(
      "fetch",
      routeFetch([
        { method: "GET", path: /\/merchants\//, respond: () => merchant() },
        {
          method: "POST",
          path: /\/transactions$/,
          respond: (init) => {
            reference = (JSON.parse(String(init?.body)) as { reference: string }).reference;
            return json(REFERENCE_USED, 422);
          },
        },
        {
          method: "GET",
          path: /\/transactions\?reference=/,
          respond: () =>
            json({
              data: [
                {
                  ...transaction("tx_old", "PENDING", reference),
                  created_at: "2026-08-18T10:00:00.000Z",
                },
                {
                  ...transaction("tx_new", "DECLINED", reference),
                  created_at: "2026-08-18T10:05:00.000Z",
                },
              ],
            }),
        },
      ]),
    );

    const summary = await t.action(async (ctx) => await wompi.processBilling(ctx));
    expect(summary.declined).toBe(1);

    const payments = await paymentsOf(t, subscription._id);
    const renewal = payments.find((p) => p.periodStart);
    expect(renewal?.status).toBe("declined");
    expect(renewal?.wompiTransactionId).toBe("tx_new");
  });

  test("the sweep looks a paid checkout up by reference before expiring it", async () => {
    const t = initConvexTest();
    const { customer } = await seed(t);
    const wompi = makeWompi({
      billing: { pendingSweepAfterMs: 0, expirePendingAfterMs: 0 },
    });

    await t.mutation(components.wompi.payments.createCheckout, {
      reference: "wmpk_paid_offline",
      customerId: customer._id,
      userId: "user_1",
      productKey: "sticker-pack",
    });
    await t.mutation(components.wompi.payments.createCheckout, {
      reference: "wmpk_abandoned",
      customerId: customer._id,
      userId: "user_1",
      productKey: "sticker-pack",
    });

    vi.stubGlobal(
      "fetch",
      routeFetch([
        {
          method: "GET",
          path: /\/transactions\?reference=wmpk_paid_offline/,
          respond: () =>
            json({
              data: [
                transaction("tx_declined", "DECLINED", "wmpk_paid_offline", 500_000),
                transaction("tx_paid", "APPROVED", "wmpk_paid_offline", 500_000),
              ],
            }),
        },
        {
          method: "GET",
          path: /\/transactions\?reference=wmpk_abandoned/,
          respond: () => json({ data: [] }),
        },
      ]),
    );

    // Let the rows age past the (zero) expiry window.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const summary = await t.action(async (ctx) => await wompi.processBilling(ctx));
    expect(summary.sweptPending).toBe(1);
    expect(summary.expired).toBe(1);

    const paid = await t.query(components.wompi.payments.getByReference, {
      reference: "wmpk_paid_offline",
    });
    expect(paid?.status).toBe("approved");
    expect(paid?.wompiTransactionId).toBe("tx_paid");
    const abandoned = await t.query(components.wompi.payments.getByReference, {
      reference: "wmpk_abandoned",
    });
    expect(abandoned?.status).toBe("expired");
  });
});

describe("payments webhook", () => {
  const routes = new Map<
    string,
    { _handler: (ctx: unknown, request: Request) => Promise<Response> }
  >();
  const http = {
    route: (spec: { path: string; handler: unknown }) => {
      routes.set(spec.path, spec.handler as never);
    },
  };

  const signedEvent = async (overrides: Record<string, unknown> = {}) => {
    const event = {
      event: "transaction.updated",
      data: {
        transaction: {
          id: "tx_hook",
          status: "APPROVED",
          reference: "wmpk_hook",
          amount_in_cents: 500_000,
          currency: "COP",
        },
      },
      environment: "test",
      signature: {
        properties: ["transaction.id", "transaction.status", "transaction.amount_in_cents"],
        checksum: "",
      },
      timestamp: 1_700_000_000,
      sent_at: "2026-08-18T10:00:00.000Z",
      ...overrides,
    };
    event.signature.checksum = await computeEventChecksum(event as never, EVENTS_KEY);
    return event;
  };

  const post = (body: unknown) =>
    new Request("https://example.convex.site/wompi/webhook", {
      method: "POST",
      body: JSON.stringify(body),
    });

  /** Actions must return Convex values, so unwrap the Response first. */
  const deliver = async (
    handler: (ctx: unknown, request: Request) => Promise<Response>,
    ctx: unknown,
    body: unknown,
  ) => {
    const response = await handler(ctx, post(body));
    return {
      status: response.status,
      body: (await response.json()) as unknown,
    };
  };

  const recordedEvent = (t: ReturnType<typeof initConvexTest>, checksum: string) =>
    t.mutation(components.wompi.webhooks.recordEvent, {
      checksum,
      eventType: "transaction.updated",
      timestamp: 1_700_000_000,
    });

  beforeEach(() => {
    routes.clear();
  });

  test("rejects a bad checksum with 403 and records nothing", async () => {
    const t = initConvexTest();
    await seed(t);
    makeWompi().registerRoutes(http as never);
    const handler = routes.get("/wompi/webhook")!._handler;

    const event = await signedEvent();
    event.signature.checksum = "deadbeef";
    const response = await t.action(async (ctx) => await deliver(handler, ctx, event));

    expect(response.status).toBe(403);
    // Nothing was recorded: recording it now reports a fresh delivery.
    expect((await recordedEvent(t, "deadbeef")).duplicate).toBe(false);
  });

  test("a crash after recording the delivery is repaired by Wompi's retry", async () => {
    const t = initConvexTest();
    const { customer } = await seed(t);
    await t.mutation(components.wompi.payments.createCheckout, {
      reference: "wmpk_hook",
      customerId: customer._id,
      userId: "user_1",
      productKey: "sticker-pack",
    });

    const callbacks: string[] = [];
    makeWompi({
      events: {
        onPaymentChange: async (_ctx, payment) => {
          callbacks.push(payment.status);
        },
      },
    }).registerRoutes(http as never);
    const handler = routes.get("/wompi/webhook")!._handler;
    const event = await signedEvent();

    // First delivery: the event is recorded, then applying it fails (OCC,
    // transient error) and the endpoint answers 500 → Wompi retries.
    let crashOnce = true;
    await expect(
      t.action(async (ctx) => {
        const flaky = {
          ...ctx,
          runMutation: async (ref: FunctionReference<"mutation">, args: unknown) => {
            // `applyTransaction` is the only mutation carrying a Wompi status.
            if (crashOnce && typeof args === "object" && args !== null && "wompiStatus" in args) {
              crashOnce = false;
              throw new Error("write conflict");
            }
            return await ctx.runMutation(ref, args as never);
          },
        };
        return await deliver(handler, flaky, event);
      }),
    ).rejects.toThrow("write conflict");

    let payment = await t.query(components.wompi.payments.getByReference, {
      reference: "wmpk_hook",
    });
    expect(payment?.status).toBe("pending");
    expect(callbacks).toEqual([]);

    // Retry: same checksum → duplicate delivery, but with no recorded
    // outcome it must be reprocessed, not short-circuited.
    const retry = await t.action(async (ctx) => await deliver(handler, ctx, event));
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual({ received: true, duplicate: true });

    payment = await t.query(components.wompi.payments.getByReference, {
      reference: "wmpk_hook",
    });
    expect(payment?.status).toBe("approved");
    expect(payment?.wompiTransactionId).toBe("tx_hook");
    expect(callbacks).toEqual(["approved"]);

    // A third delivery is a plain duplicate: no reprocessing, no callback.
    const third = await t.action(async (ctx) => await deliver(handler, ctx, event));
    expect(third.body).toEqual({ received: true, duplicate: true });
    expect(callbacks).toEqual(["approved"]);

    const recorded = await recordedEvent(t, event.signature.checksum);
    expect(recorded.duplicate).toBe(true);
    expect(recorded.outcome).toBe("applied");
  });
});

// Registered Convex functions keep the raw handler on `_handler` (how convex-test
// itself invokes them); calling it directly runs the function without an
// `api` module wired up.
type Handler = (ctx: unknown, args: Record<string, unknown>) => Promise<unknown>;
const handlerOf = (fn: unknown): Handler => (fn as { _handler: Handler })._handler;
const exportedArgs = (fn: unknown) =>
  JSON.parse((fn as { exportArgs: () => string }).exportArgs()) as {
    value: Record<string, { optional: boolean }>;
  };

describe("prebuilt api()", () => {
  const authedConfig: Partial<WompiConfig> = {
    getUserInfo: async (ctx) => {
      const identity = await ctx.auth.getUserIdentity();
      if (!identity) throw new Error("Unauthenticated");
      return {
        userId: identity.subject,
        email: identity.email ?? "user@example.com",
      };
    },
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("checkout only accepts a catalog product — no client-supplied amount or metadata", () => {
    const api = makeWompi().api();
    const args = exportedArgs(api.checkout);
    expect(args.value.productKey.optional).toBe(false);
    expect(args.value.redirectUrl.optional).toBe(false);
    expect(Object.keys(args.value).sort()).toEqual(["productKey", "redirectUrl"]);
  });

  test("every identity-bound function resolves the user through getUserInfo", async () => {
    const t = initConvexTest();
    await seed(t);
    const api = makeWompi(authedConfig).api();

    const calls: [string, () => Promise<unknown>][] = [
      [
        "getCurrentSubscription",
        () => t.query(async (ctx) => await handlerOf(api.getCurrentSubscription)(ctx, {})),
      ],
      [
        "listSubscriptions",
        () => t.query(async (ctx) => await handlerOf(api.listSubscriptions)(ctx, {})),
      ],
      ["listPayments", () => t.query(async (ctx) => await handlerOf(api.listPayments)(ctx, {}))],
      [
        "getPayment",
        () => t.query(async (ctx) => await handlerOf(api.getPayment)(ctx, { reference: "x" })),
      ],
      [
        "checkout",
        () =>
          t.action(
            async (ctx) =>
              await handlerOf(api.checkout)(ctx, {
                redirectUrl: "https://app.test",
                productKey: "sticker-pack",
              }),
          ),
      ],
      [
        "confirmTransaction",
        () =>
          t.action(
            async (ctx) =>
              await handlerOf(api.confirmTransaction)(ctx, {
                transactionId: "tx",
              }),
          ),
      ],
      [
        "subscribe",
        () =>
          t.action(
            async (ctx) =>
              await handlerOf(api.subscribe)(ctx, {
                productKey: "pro-monthly",
                token: "tok",
              }),
          ),
      ],
      [
        "cancelSubscription",
        () =>
          t.mutation(
            async (ctx) =>
              await handlerOf(api.cancelSubscription)(ctx, {
                subscriptionId: "s",
              }),
          ),
      ],
      [
        "resumeSubscription",
        () =>
          t.mutation(
            async (ctx) =>
              await handlerOf(api.resumeSubscription)(ctx, {
                subscriptionId: "s",
              }),
          ),
      ],
      [
        "changeSubscription",
        () =>
          t.mutation(
            async (ctx) =>
              await handlerOf(api.changeSubscription)(ctx, {
                subscriptionId: "s",
                productKey: "pro-monthly",
              }),
          ),
      ],
    ];

    // Anonymous callers are rejected before anything reaches Wompi.
    vi.stubGlobal("fetch", routeFetch([]));
    for (const [name, call] of calls) {
      await expect(call(), name).rejects.toThrow("Unauthenticated");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  test("confirmTransaction redacts payments that belong to another user", async () => {
    const t = initConvexTest();
    const { customer } = await seed(t);
    await t.mutation(components.wompi.payments.createCheckout, {
      reference: "wmpk_mine",
      customerId: customer._id,
      userId: "user_1",
      productKey: "sticker-pack",
    });
    vi.stubGlobal(
      "fetch",
      routeFetch([
        {
          method: "GET",
          path: /\/transactions\/tx_mine$/,
          respond: () =>
            json({
              data: transaction("tx_mine", "APPROVED", "wmpk_mine", 500_000),
            }),
        },
      ]),
    );
    const api = makeWompi(authedConfig).api();

    // Anyone can hold a transaction id (it travels in the redirect URL);
    // another signed-in user gets the state machine's verdict, not the row.
    const asOther = (await t.withIdentity({ subject: "user_2", email: "bob@example.com" }).action(
      async (ctx) =>
        await handlerOf(api.confirmTransaction)(ctx, {
          transactionId: "tx_mine",
        }),
    )) as ChargeOutcome;
    expect(asOther.outcome).toBe("applied");
    expect(asOther.payment).toBeNull();
    expect(asOther.subscription).toBeNull();

    const asOwner = (await t.withIdentity({ subject: "user_1", email: "ada@example.com" }).action(
      async (ctx) =>
        await handlerOf(api.confirmTransaction)(ctx, {
          transactionId: "tx_mine",
        }),
    )) as ChargeOutcome;
    expect(asOwner.outcome).toBe("noop");
    expect(asOwner.payment?.userId).toBe("user_1");
    expect(asOwner.payment?.status).toBe("approved");
  });
});
