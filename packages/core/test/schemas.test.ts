import { describe, it, expect } from "vitest";
import {
  CardTokenSchema,
  CreateTransactionInputSchema,
  FinancialInstitutionSchema,
  MerchantSchema,
  NequiTokenSchema,
  NequiTokenStatusSchema,
  PaymentLinkSchema,
  PaymentMethodTypeSchema,
  PaymentSourceSchema,
  PaymentSourceStatusSchema,
  TransactionSchema,
  TransactionStatusSchema,
} from "../src/schemas";

/**
 * The response schemas are deliberately lenient: Wompi's spec marks almost no
 * response field as required, so a real API success must never surface as a
 * validation error. These tests pin that contract — minimal payloads parse,
 * unknown fields pass through, and drift-prone enums accept arbitrary strings —
 * while the strict input schemas and status enums keep rejecting bad data.
 */
describe("response schemas (lenient)", () => {
  describe("TransactionSchema", () => {
    it("accepts a payload carrying only the stable identifiers", () => {
      const result = TransactionSchema.safeParse({
        id: "txn-1",
        status: "APPROVED",
        reference: "ref-1",
      });

      expect(result.success).toBe(true);
    });

    it("preserves unknown fields via .loose()", () => {
      const result = TransactionSchema.parse({
        id: "txn-1",
        status: "APPROVED",
        reference: "ref-1",
        future_field_wompi_added: "keep me",
      });

      expect(result).toHaveProperty("future_field_wompi_added", "keep me");
    });

    it("accepts an unknown payment_method_type string", () => {
      const result = TransactionSchema.safeParse({
        id: "txn-1",
        status: "APPROVED",
        reference: "ref-1",
        payment_method_type: "SOME_NEW_METHOD",
      });

      expect(result.success).toBe(true);
    });

    it("accepts a null status_message", () => {
      const result = TransactionSchema.safeParse({
        id: "txn-1",
        status: "DECLINED",
        reference: "ref-1",
        status_message: null,
      });

      expect(result.success).toBe(true);
    });

    it("still requires id, status and reference", () => {
      expect(TransactionSchema.safeParse({ status: "APPROVED", reference: "r" }).success).toBe(
        false
      );
      expect(TransactionSchema.safeParse({ id: "t", reference: "r" }).success).toBe(false);
      expect(TransactionSchema.safeParse({ id: "t", status: "APPROVED" }).success).toBe(false);
    });

    it("still rejects an unknown status — the status enum stays strict", () => {
      const result = TransactionSchema.safeParse({
        id: "txn-1",
        status: "REFUNDED",
        reference: "ref-1",
      });

      expect(result.success).toBe(false);
    });
  });

  describe("MerchantSchema", () => {
    it("accepts a payload carrying only the id", () => {
      expect(MerchantSchema.safeParse({ id: 123 }).success).toBe(true);
    });

    it("accepts unknown legal_id_type and accepted_payment_methods strings", () => {
      const result = MerchantSchema.safeParse({
        id: 123,
        legal_id_type: "FUTURE_ID_TYPE",
        accepted_payment_methods: ["CARD", "SOME_NEW_METHOD"],
      });

      expect(result.success).toBe(true);
    });
  });

  describe("PaymentSourceSchema", () => {
    it("accepts a payload carrying only id and status", () => {
      expect(PaymentSourceSchema.safeParse({ id: 1, status: "AVAILABLE" }).success).toBe(true);
    });
  });

  describe("CardTokenSchema / NequiTokenSchema", () => {
    it("CardTokenSchema accepts a payload carrying only the id", () => {
      expect(CardTokenSchema.safeParse({ id: "tok_1" }).success).toBe(true);
    });

    it("NequiTokenSchema accepts a payload carrying only id and status", () => {
      expect(NequiTokenSchema.safeParse({ id: "nequi_1", status: "PENDING" }).success).toBe(true);
    });
  });

  describe("FinancialInstitutionSchema", () => {
    it("accepts a payload carrying only the code", () => {
      expect(
        FinancialInstitutionSchema.safeParse({ financial_institution_code: "1051" }).success
      ).toBe(true);
    });
  });

  describe("PaymentLinkSchema", () => {
    it("accepts a payload carrying only the id", () => {
      expect(PaymentLinkSchema.safeParse({ id: "link_1" }).success).toBe(true);
    });
  });
});

describe("status enums (strict)", () => {
  it("TransactionStatusSchema rejects unknown values", () => {
    expect(TransactionStatusSchema.safeParse("REFUNDED").success).toBe(false);
    expect(TransactionStatusSchema.safeParse("APPROVED").success).toBe(true);
  });

  it("PaymentSourceStatusSchema rejects unknown values", () => {
    expect(PaymentSourceStatusSchema.safeParse("EXPIRED").success).toBe(false);
    expect(PaymentSourceStatusSchema.safeParse("AVAILABLE").success).toBe(true);
  });

  it("NequiTokenStatusSchema rejects unknown values", () => {
    expect(NequiTokenStatusSchema.safeParse("EXPIRED").success).toBe(false);
    expect(NequiTokenStatusSchema.safeParse("APPROVED").success).toBe(true);
  });
});

describe("PaymentMethodTypeSchema (strict input filter)", () => {
  it("accepts the methods documented by Wompi's spec", () => {
    for (const method of [
      "CARD",
      "NEQUI",
      "PSE",
      "BANCOLOMBIA_TRANSFER",
      "BANCOLOMBIA_QR",
      "BANCOLOMBIA_BNPL",
      "DAVIPLATA",
      "SU_PLUS",
      "CARD_POS",
    ]) {
      expect(PaymentMethodTypeSchema.safeParse(method).success).toBe(true);
    }
  });

  it("rejects an unknown method", () => {
    expect(PaymentMethodTypeSchema.safeParse("BITCOIN").success).toBe(false);
  });
});

describe("CreateTransactionInputSchema (strict input)", () => {
  const base = {
    acceptance_token: "acc_tok",
    amount_in_cents: 2_490_000,
    currency: "COP",
    signature: "sig",
    customer_email: "buyer@example.com",
    reference: "ref-1",
  };

  it("accepts exactly one of payment_method / payment_source_id", () => {
    expect(
      CreateTransactionInputSchema.safeParse({
        ...base,
        payment_method: { type: "CARD" },
      }).success
    ).toBe(true);

    expect(
      CreateTransactionInputSchema.safeParse({
        ...base,
        payment_source_id: 42,
      }).success
    ).toBe(true);
  });

  it("accepts both payment_method and payment_source_id (recurring card charge)", () => {
    // Wompi requires payment_method.installments when charging a saved CARD
    // source, so the two fields legitimately travel together.
    expect(
      CreateTransactionInputSchema.safeParse({
        ...base,
        payment_method: { installments: 1 },
        payment_source_id: 42,
      }).success
    ).toBe(true);
  });

  it("rejects passing neither payment_method nor payment_source_id", () => {
    expect(CreateTransactionInputSchema.safeParse(base).success).toBe(false);
  });

  it("keeps the second acceptance token and the optional documented fields", () => {
    const result = CreateTransactionInputSchema.parse({
      ...base,
      accept_personal_auth: "personal_auth_tok",
      payment_method: { type: "CARD" },
      taxes: [{ type: "VAT", amount_in_cents: 478_000 }],
      ip: "190.0.0.1",
      recurrent: true,
      parent_transaction_id: "txn-parent",
      payment_method_type: "CARD",
    });

    expect(result).toMatchObject({
      accept_personal_auth: "personal_auth_tok",
      taxes: [{ type: "VAT", amount_in_cents: 478_000 }],
      ip: "190.0.0.1",
      recurrent: true,
      parent_transaction_id: "txn-parent",
      payment_method_type: "CARD",
    });
  });

  it("keeps unknown fields instead of stripping them — the payload is loose", () => {
    const result = CreateTransactionInputSchema.parse({
      ...base,
      payment_method: { type: "CARD" },
      future_field_wompi_added: "keep me",
    });

    expect(result).toHaveProperty("future_field_wompi_added", "keep me");
  });

  it("rejects an amount_in_cents above Wompi's maximum", () => {
    expect(
      CreateTransactionInputSchema.safeParse({
        ...base,
        amount_in_cents: 1_000_000_000_001,
        payment_method: { type: "CARD" },
      }).success
    ).toBe(false);
  });

  it("rejects a malformed customer_email", () => {
    expect(
      CreateTransactionInputSchema.safeParse({
        ...base,
        customer_email: "not-an-email",
        payment_method: { type: "CARD" },
      }).success
    ).toBe(false);
  });

  it("rejects a non-integer payment_source_id", () => {
    expect(
      CreateTransactionInputSchema.safeParse({
        ...base,
        payment_source_id: 4.2,
      }).success
    ).toBe(false);
  });
});
