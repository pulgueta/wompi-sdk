import { z } from "zod";

import type { WompiPayoutApiError } from "@/payouts-schemas";

/** Maximum amount Wompi accepts, in cents (spec: `amount_in_cents` `maximum: 1E12`). */
export const MAX_AMOUNT_IN_CENTS = 1_000_000_000_000;

export const CurrencySchema = z.literal("COP");

export const PaymentMethodTypeSchema = z.enum([
  "CARD",
  "NEQUI",
  "PSE",
  "BANCOLOMBIA",
  "BANCOLOMBIA_TRANSFER",
  "BANCOLOMBIA_COLLECT",
  "BANCOLOMBIA_QR",
  "BANCOLOMBIA_BNPL",
  "DAVIPLATA",
  "SU_PLUS",
  "CARD_POS",
]);

export const TransactionStatusSchema = z.enum([
  "PENDING",
  "APPROVED",
  "DECLINED",
  "ERROR",
  "VOIDED",
]);

export const PaymentSourceTypeSchema = z.enum([
  "CARD",
  "NEQUI",
  "DAVIPLATA",
  "BANCOLOMBIA_TRANSFER",
]);

export const PaymentSourceStatusSchema = z.enum(["AVAILABLE", "PENDING", "VOIDED"]);

export const NequiTokenStatusSchema = z.enum(["PENDING", "APPROVED", "DECLINED"]);

export const LegalIdTypeSchema = z.enum(["CC", "NIT", "PP", "CE", "TI", "DNI", "RG", "OTHER"]);

export const TaxTypeSchema = z.enum(["VAT", "CONSUMPTION"]);

export const OrderDirectionSchema = z.enum(["DESC", "ASC"]);

export const AcceptanceTypeSchema = z.enum(["END_USER_POLICY", "PERSONAL_DATA_AUTH"]);

export const MerchantLegalIdTypeSchema = z.enum(["NIT", "CC"]);

export const CustomerDataSchema = z.object({
  phone_number: z.string().optional(),
  full_name: z.string(),
  legal_id: z.string().optional(),
  legal_id_type: LegalIdTypeSchema.optional(),
});

export const ShippingAddressSchema = z.object({
  address_line_1: z.string(),
  address_line_2: z.string().optional(),
  country: z.string(),
  region: z.string(),
  city: z.string(),
  name: z.string().optional(),
  phone_number: z.string(),
  postal_code: z.string().optional(),
});

/**
 * Lenient by design: the direct flow sends `{ type, token, installments… }`,
 * while charges against a saved `payment_source_id` send only
 * `{ installments }` — Wompi infers the type from the source.
 */
export const TransactionPaymentMethodSchema = z
  .object({
    type: z.string().optional(),
    installments: z.number().int().min(1).optional(),
  })
  .loose();

export const TaxByAmountSchema = z.object({
  type: TaxTypeSchema,
  amount_in_cents: z.number().int().min(1).max(MAX_AMOUNT_IN_CENTS),
});

export const TaxByPercentageSchema = z.object({
  type: TaxTypeSchema,
  percentage: z.number().int().min(1).max(50),
});

export const TaxSchema = z.union([TaxByAmountSchema, TaxByPercentageSchema]);

/**
 * `POST /transactions` payload.
 *
 * Wompi requires two acceptance tokens: `acceptance_token` (from
 * `merchant.presigned_acceptance`) and `accept_personal_auth` (from
 * `merchant.presigned_personal_data_auth`). Both are required here, so a
 * request without them is rejected locally before anything is sent.
 *
 * The object is `.loose()` so any field Wompi documents but the SDK does not
 * name still reaches the API — stripping it would silently change the request.
 */
export const CreateTransactionInputSchema = z
  .object({
    acceptance_token: z.string(),
    accept_personal_auth: z.string(),
    amount_in_cents: z.number().int().min(1).max(MAX_AMOUNT_IN_CENTS),
    currency: CurrencySchema,
    signature: z.string(),
    customer_email: z.email(),
    payment_method: TransactionPaymentMethodSchema.optional(),
    payment_method_type: z.string().optional(),
    payment_source_id: z.number().int().positive().optional(),
    redirect_url: z.url().optional(),
    reference: z.string(),
    expiration_time: z.string().optional(),
    customer_data: CustomerDataSchema.optional(),
    shipping_address: ShippingAddressSchema.optional(),
    taxes: z.array(TaxSchema).optional(),
    ip: z.string().optional(),
    recurrent: z.boolean().optional(),
    parent_transaction_id: z.string().optional(),
  })
  .loose()
  .refine((data) => data.payment_method !== undefined || data.payment_source_id !== undefined, {
    message: "Provide payment_method, payment_source_id, or both",
  });

/**
 * Response shape of a transaction.
 *
 * Wompi's spec marks no response field as required, so every non-identity field is
 * optional/nullish and unknown fields pass through — a successful API call must never
 * be reported as a validation error. Only `id`, `status` and `reference` are kept
 * required, as the stable identifiers consumers rely on.
 */
export const TransactionSchema = z
  .object({
    id: z.string(),
    status: TransactionStatusSchema,
    reference: z.string(),
    created_at: z.string().optional(),
    amount_in_cents: z.number().int().optional(),
    customer_email: z.string().optional(),
    currency: CurrencySchema.optional(),
    payment_method_type: z.string().optional(),
    payment_method: TransactionPaymentMethodSchema.optional(),
    status_message: z.string().nullish(),
    shipping_address: ShippingAddressSchema.nullish(),
    redirect_url: z.string().nullish(),
    payment_link_id: z.string().nullish(),
  })
  .loose();

export const TransactionListParamsSchema = z.object({
  reference: z.string().optional(),
  from_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD format")
    .optional(),
  until_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD format")
    .optional(),
  page: z.number().int().min(1).max(1_000_000).optional(),
  page_size: z.number().int().min(1).max(200).optional(),
  id: z.string().optional(),
  payment_method_type: PaymentMethodTypeSchema.optional(),
  status: TransactionStatusSchema.optional(),
  customer_email: z.email().optional(),
  order_by: z.string().optional(),
  order: OrderDirectionSchema.optional(),
});

export const VoidTransactionInputSchema = z.object({
  amount_in_cents: z.number().int().min(1).max(MAX_AMOUNT_IN_CENTS).optional(),
});

/**
 * Response payload of `POST /transactions/{id}/void`.
 *
 * Wompi's spec documents an empty `201`, but the API actually answers with a
 * body wrapping the void outcome: a top-level `status` plus the voided
 * transaction nested under `transaction`. Lenient, like every response schema.
 */
export const VoidTransactionResultSchema = z
  .object({
    status: z.string().optional(),
    status_message: z.string().nullish(),
    transaction: TransactionSchema.optional(),
  })
  .loose();

export const TokenizeCardInputSchema = z.object({
  number: z.string(),
  cvc: z.string(),
  exp_month: z.string(),
  exp_year: z.string(),
  card_holder: z.string(),
});

export const TokenizeNequiInputSchema = z.object({
  phone_number: z.string(),
});

export const CardTokenSchema = z
  .object({
    id: z.string(),
    created_at: z.string().optional(),
    brand: z.string().optional(),
    name: z.string().optional(),
    last_four: z.string().optional(),
    bin: z.string().optional(),
    exp_year: z.string().optional(),
    exp_month: z.string().optional(),
    card_holder: z.string().optional(),
    expires_at: z.string().optional(),
  })
  .loose();

export const NequiTokenSchema = z
  .object({
    id: z.string(),
    status: NequiTokenStatusSchema,
    phone_number: z.string().optional(),
    name: z.string().optional(),
  })
  .loose();

export const PaymentSourcePublicDataSchema = z
  .object({
    type: z.string(),
    phone_number: z.string().optional(),
  })
  .loose();

/**
 * Response shape of a payment source.
 *
 * `type` and `status` stay plain strings: Wompi adds source kinds and states over
 * time, and a `200` must never surface as a validation error. Use
 * {@link PaymentSourceTypeSchema} / {@link PaymentSourceStatusSchema} (and their
 * `PaymentSourceType` / `PaymentSourceStatus` types) to narrow on the known values.
 */
export const PaymentSourceSchema = z
  .object({
    id: z.number().int(),
    status: z.string(),
    type: z.string().optional(),
    token: z.string().optional(),
    customer_email: z.string().optional(),
    public_data: PaymentSourcePublicDataSchema.optional(),
  })
  .loose();

/**
 * `POST /payment_sources` payload.
 *
 * Like a transaction, a payment source needs both acceptance tokens:
 * `acceptance_token` and `accept_personal_auth`. `.loose()` for the same reason —
 * documented fields the SDK does not name must still reach Wompi.
 */
export const CreatePaymentSourceInputSchema = z
  .object({
    type: PaymentSourceTypeSchema,
    token: z.string(),
    acceptance_token: z.string(),
    accept_personal_auth: z.string(),
    customer_email: z.email(),
    payment_description: z.string().optional(),
  })
  .loose();

export const CustomerReferenceSchema = z.object({
  label: z.string().max(24),
  is_required: z.boolean(),
});

export const PaymentLinkCustomerDataSchema = z.object({
  customer_references: z.array(CustomerReferenceSchema).max(2).optional(),
});

export const CreatePaymentLinkInputSchema = z.object({
  name: z.string(),
  description: z.string(),
  single_use: z.boolean(),
  collect_shipping: z.boolean(),
  collect_customer_legal_id: z.boolean().optional(),
  amount_in_cents: z.number().int().min(1).max(MAX_AMOUNT_IN_CENTS).optional(),
  currency: CurrencySchema.optional(),
  signature: z.string().optional(),
  reference: z.string().optional(),
  expiration_time: z.string().optional(),
  sku: z.string().max(36).optional(),
  expires_at: z.string().optional(),
  redirect_url: z.string().optional(),
  image_url: z.string().optional(),
  customer_data: PaymentLinkCustomerDataSchema.optional(),
  taxes: z.array(TaxSchema).optional(),
});

/**
 * Response shape of a payment link.
 *
 * Wompi returns `null` (not absent) for every optional field the merchant did not set,
 * so all such fields are `.nullish()` — a successful API call must never be reported as
 * a validation error. `checkout_url` is injected by the SDK after parsing, so callers
 * don't have to build `https://checkout.wompi.co/l/{id}` themselves.
 */
export const PaymentLinkSchema = z
  .object({
    id: z.string(),
    name: z.string().nullish(),
    description: z.string().nullish(),
    single_use: z.boolean().nullish(),
    collect_shipping: z.boolean().nullish(),
    collect_customer_legal_id: z.boolean().nullish(),
    amount_in_cents: z.number().int().nullish(),
    currency: CurrencySchema.nullish(),
    signature: z.string().nullish(),
    reference: z.string().nullish(),
    expiration_time: z.string().nullish(),
    sku: z.string().nullish(),
    expires_at: z.string().nullish(),
    redirect_url: z.string().nullish(),
    image_url: z.string().nullish(),
    customer_data: PaymentLinkCustomerDataSchema.nullish(),
    taxes: z.array(TaxSchema).nullish(),
    active: z.boolean().optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
    checkout_url: z.string().optional(),
  })
  .loose();

export const UpdatePaymentLinkInputSchema = z.object({
  active: z.boolean(),
});

export const PresignedAcceptanceSchema = z.object({
  acceptance_token: z.string(),
  permalink: z.string(),
  type: AcceptanceTypeSchema,
});

export const MerchantSchema = z
  .object({
    id: z.number().int(),
    name: z.string().optional(),
    legal_name: z.string().optional(),
    legal_id: z.string().optional(),
    legal_id_type: z.string().optional(),
    phone_number: z.string().optional(),
    active: z.boolean().optional(),
    logo_url: z.string().nullish(),
    email: z.string().optional(),
    contact_name: z.string().optional(),
    public_key: z.string().optional(),
    accepted_payment_methods: z.array(z.string()).optional(),
    accepted_currencies: z.array(CurrencySchema).optional(),
    presigned_acceptance: PresignedAcceptanceSchema.optional(),
    presigned_personal_data_auth: PresignedAcceptanceSchema.optional(),
  })
  .loose();

export const FinancialInstitutionSchema = z
  .object({
    financial_institution_code: z.string(),
    financial_institution_name: z.string().optional(),
  })
  .loose();

/**
 * Wraps a data schema in Wompi's `{ data, meta? }` envelope and immediately
 * unwraps to `data` after parsing. The wire format is preserved for validation,
 * but callers receive the payload directly — `response.X` instead of
 * `response.data.X`. The `meta` channel (only carries pagination) is dropped.
 */
export const wompiResponse = <T extends z.ZodType>(dataSchema: T) =>
  z
    .object({
      data: dataSchema,
      meta: z.record(z.string(), z.unknown()).optional(),
    })
    .transform((parsed) => (parsed as { data: z.output<T> }).data);

export const wompiListResponse = <T extends z.ZodType>(itemSchema: T) =>
  z
    .object({
      data: z.array(itemSchema),
      meta: z.record(z.string(), z.unknown()).optional(),
    })
    .transform((parsed) => (parsed as { data: z.output<T>[] }).data);

export const WebhookSignatureSchema = z.object({
  properties: z.array(z.string()),
  checksum: z.string(),
});

/**
 * Envelope of every event Wompi POSTs to the configured Events URL.
 *
 * `event` stays a plain string (Wompi adds event types over time); use
 * {@link TransactionUpdatedEventSchema} or the `isTransactionUpdatedEvent`
 * guard from `/server` to narrow the payload of known types.
 */
export const WebhookEventSchema = z
  .object({
    event: z.string(),
    data: z.record(z.string(), z.unknown()),
    environment: z.string(),
    signature: WebhookSignatureSchema,
    timestamp: z.number(),
    sent_at: z.string().optional(),
  })
  .loose();

export const TransactionUpdatedEventSchema = z
  .object({
    event: z.literal("transaction.updated"),
    data: z.object({ transaction: TransactionSchema }),
    environment: z.string(),
    signature: WebhookSignatureSchema,
    timestamp: z.number(),
    sent_at: z.string().optional(),
  })
  .loose();

export const NequiTokenUpdatedEventSchema = z
  .object({
    event: z.literal("nequi_token.updated"),
    data: z.object({ nequi_token: NequiTokenSchema }),
    environment: z.string(),
    signature: WebhookSignatureSchema,
    timestamp: z.number(),
    sent_at: z.string().optional(),
  })
  .loose();

export const NotFoundErrorResponseSchema = z.object({
  error: z.object({
    type: z.literal("NOT_FOUND_ERROR"),
    reason: z.string(),
  }),
});

export const InputValidationErrorResponseSchema = z.object({
  error: z.object({
    type: z.literal("INPUT_VALIDATION_ERROR"),
    messages: z.record(z.string(), z.array(z.string())),
  }),
});

export const WompiClientOptionsSchema = z.object({
  publicKey: z.string().min(1, "A public key is required"),
  privateKey: z.string().optional(),
  sandbox: z.boolean().default(false),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Currency = z.output<typeof CurrencySchema>;
export type PaymentMethodType = z.output<typeof PaymentMethodTypeSchema>;
export type TransactionStatus = z.output<typeof TransactionStatusSchema>;
export type PaymentSourceType = z.output<typeof PaymentSourceTypeSchema>;
export type PaymentSourceStatus = z.output<typeof PaymentSourceStatusSchema>;
export type NequiTokenStatus = z.output<typeof NequiTokenStatusSchema>;
export type LegalIdType = z.output<typeof LegalIdTypeSchema>;
export type TaxType = z.output<typeof TaxTypeSchema>;
export type OrderDirection = z.output<typeof OrderDirectionSchema>;
export type AcceptanceType = z.output<typeof AcceptanceTypeSchema>;
export type MerchantLegalIdType = z.output<typeof MerchantLegalIdTypeSchema>;

export type CustomerData = z.output<typeof CustomerDataSchema>;
export type ShippingAddress = z.output<typeof ShippingAddressSchema>;
export type TransactionPaymentMethod = z.output<typeof TransactionPaymentMethodSchema>;

export type CreateTransactionInput = z.output<typeof CreateTransactionInputSchema>;
export type Transaction = z.output<typeof TransactionSchema>;
export type TransactionListParams = z.output<typeof TransactionListParamsSchema>;
export type VoidTransactionInput = z.output<typeof VoidTransactionInputSchema>;
export type VoidTransactionResult = z.output<typeof VoidTransactionResultSchema>;

export type TokenizeCardInput = z.output<typeof TokenizeCardInputSchema>;
export type TokenizeNequiInput = z.output<typeof TokenizeNequiInputSchema>;
export type CardToken = z.output<typeof CardTokenSchema>;
export type NequiToken = z.output<typeof NequiTokenSchema>;

export type PaymentSourcePublicData = z.output<typeof PaymentSourcePublicDataSchema>;
export type PaymentSource = z.output<typeof PaymentSourceSchema>;
export type CreatePaymentSourceInput = z.output<typeof CreatePaymentSourceInputSchema>;

export type CustomerReference = z.output<typeof CustomerReferenceSchema>;
export type PaymentLinkCustomerData = z.output<typeof PaymentLinkCustomerDataSchema>;
export type TaxByAmount = z.output<typeof TaxByAmountSchema>;
export type TaxByPercentage = z.output<typeof TaxByPercentageSchema>;
export type Tax = z.output<typeof TaxSchema>;
export type CreatePaymentLinkInput = z.output<typeof CreatePaymentLinkInputSchema>;
export type PaymentLink = z.output<typeof PaymentLinkSchema>;
export type UpdatePaymentLinkInput = z.output<typeof UpdatePaymentLinkInputSchema>;

export type PresignedAcceptance = z.output<typeof PresignedAcceptanceSchema>;
export type Merchant = z.output<typeof MerchantSchema>;

export type FinancialInstitution = z.output<typeof FinancialInstitutionSchema>;

export type WebhookSignature = z.output<typeof WebhookSignatureSchema>;
export type WebhookEvent = z.output<typeof WebhookEventSchema>;
export type TransactionUpdatedEvent = z.output<typeof TransactionUpdatedEventSchema>;
export type NequiTokenUpdatedEvent = z.output<typeof NequiTokenUpdatedEventSchema>;

export type NotFoundErrorResponse = z.output<typeof NotFoundErrorResponseSchema>;
export type InputValidationErrorResponse = z.output<typeof InputValidationErrorResponseSchema>;

export type WompiClientOptions = z.input<typeof WompiClientOptionsSchema>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class WompiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WompiError";
  }
}

export class WompiNotFoundError extends WompiError {
  readonly type = "NOT_FOUND_ERROR" as const;
  readonly reason: string;

  constructor(response: NotFoundErrorResponse) {
    super(response.error.reason);
    this.name = "WompiNotFoundError";
    this.reason = response.error.reason;
  }
}

export class WompiValidationError extends WompiError {
  readonly type = "INPUT_VALIDATION_ERROR" as const;
  readonly messages: Record<string, string[]>;

  constructor(response: InputValidationErrorResponse) {
    const flatMessages = Object.entries(response.error.messages)
      .map(([field, errors]) => `${field}: ${errors.join(", ")}`)
      .join("; ");

    super(`Validation failed: ${flatMessages}`);
    this.name = "WompiValidationError";
    this.messages = response.error.messages;
  }
}

export class WompiRequestError extends WompiError {
  readonly statusCode: number;
  readonly body: unknown;

  constructor(statusCode: number, body: unknown) {
    super(`Request failed with status ${statusCode}`);
    this.name = "WompiRequestError";
    this.statusCode = statusCode;
    this.body = body;
  }
}

export class WompiWebhookVerificationError extends WompiError {
  readonly type = "WEBHOOK_VERIFICATION_ERROR" as const;

  constructor(message: string) {
    super(message);
    this.name = "WompiWebhookVerificationError";
  }
}

/**
 * Every error a {@link Result} can carry. The subclasses expose discriminants
 * (`.type` on not-found / validation errors, `.statusCode` on request errors), so
 * consumers can branch without `instanceof`.
 */
export type WompiErrorResult =
  | WompiError
  | WompiNotFoundError
  | WompiPayoutApiError
  | WompiRequestError
  | WompiValidationError
  | WompiWebhookVerificationError;

/**
 * Discriminated result tuple for error-first handling.
 *
 * Usage:
 * ```ts
 * const [error, data] = await wompi.transactions.getTransaction("id");
 * if (error) {
 *   // error is a WompiError (or one of its subclasses)
 *   return;
 * }
 * // data is fully typed
 * ```
 */
export type Result<T> = [error: WompiErrorResult, data: null] | [error: null, data: T];
