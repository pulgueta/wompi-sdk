import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WompiClient } from "../src";
import { WompiError } from "../src/schemas";
import { okJson, okEmpty } from "./helpers";

const TRANSACTION_RESPONSE = {
  data: {
    id: "txn-123",
    created_at: "2024-01-01",
    amount_in_cents: 3000000,
    status: "APPROVED",
    reference: "ref-123",
    customer_email: "test@example.com",
    currency: "COP",
    payment_method_type: "CARD",
    payment_method: { type: "CARD" },
    shipping_address: null,
    redirect_url: null,
    payment_link_id: null,
  },
};

describe("Transactions", () => {
  const mockFetch = vi.fn();
  const PUBLIC_KEY = "pub_test_123";
  const PRIVATE_KEY = "prv_test_456";

  const makeClient = (privateKey: string | undefined) =>
    new WompiClient({ publicKey: PUBLIC_KEY, privateKey, sandbox: true }).transactions;

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("getTransaction", () => {
    it("should return [null, data] for a valid transaction", async () => {
      const transactions = makeClient(PRIVATE_KEY);

      mockFetch.mockResolvedValueOnce(okJson(TRANSACTION_RESPONSE));

      const [error, data] = await transactions.getTransaction("txn-123");

      expect(error).toBeNull();
      expect(data!.id).toBe("txn-123");
      expect(data!.status).toBe("APPROVED");
    });

    it("should accept a partial transaction body without a false error", async () => {
      const transactions = makeClient(PRIVATE_KEY);

      // A status-style response: no created_at, customer_email or payment_method,
      // and an unknown payment_method_type — none of which should fail validation.
      mockFetch.mockResolvedValueOnce(
        okJson({
          data: {
            id: "txn-789",
            status: "APPROVED",
            reference: "ref-789",
            amount_in_cents: 2490000,
            currency: "COP",
            payment_method_type: "SU_PLUS",
            status_message: "Aprobada",
          },
        })
      );

      const [error, data] = await transactions.getTransaction("txn-789");

      expect(error).toBeNull();
      expect(data!.id).toBe("txn-789");
      expect(data!.payment_method).toBeUndefined();
    });
  });

  describe("listTransactions", () => {
    it("should return [null, data] with valid params", async () => {
      const transactions = makeClient(PRIVATE_KEY);

      mockFetch.mockResolvedValueOnce(okJson({ data: [TRANSACTION_RESPONSE.data] }));

      const [error, data] = await transactions.listTransactions({
        from_date: "2024-01-01",
        until_date: "2024-12-31",
        page: 1,
        page_size: 50,
      });

      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    });

    it("should return [error, null] when private key is missing", async () => {
      const transactions = makeClient(undefined);

      const [error, data] = await transactions.listTransactions();

      expect(data).toBeNull();
      expect(error).toBeInstanceOf(WompiError);
      expect(error!.message).toContain("Private key is required");
    });

    it("should return [error, null] on invalid from_date format", async () => {
      const transactions = makeClient(PRIVATE_KEY);

      const [error, data] = await transactions.listTransactions({
        from_date: "01-2024-01",
      });

      expect(data).toBeNull();
      expect(error).toBeInstanceOf(WompiError);
      expect(error!.message).toContain("Invalid parameters");
    });

    it("should return [error, null] when page is less than 1", async () => {
      const transactions = makeClient(PRIVATE_KEY);

      const [error, data] = await transactions.listTransactions({ page: 0 });

      expect(data).toBeNull();
      expect(error).toBeInstanceOf(WompiError);
    });

    it("should return [error, null] when page_size exceeds 200", async () => {
      const transactions = makeClient(PRIVATE_KEY);

      const [error, data] = await transactions.listTransactions({ page_size: 201 });

      expect(data).toBeNull();
      expect(error).toBeInstanceOf(WompiError);
    });

    it("should include optional query parameters", async () => {
      const transactions = makeClient(PRIVATE_KEY);

      mockFetch.mockResolvedValueOnce(okJson({ data: [] }));

      const [error] = await transactions.listTransactions({
        reference: "ref-123",
        status: "APPROVED",
        payment_method_type: "CARD",
        order: "DESC",
      });

      expect(error).toBeNull();

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toContain("reference=ref-123");
      expect(url).toContain("status=APPROVED");
      expect(url).toContain("payment_method_type=CARD");
      expect(url).toContain("order=DESC");
    });
  });

  describe("createTransaction", () => {
    it("should return [null, data] with valid input", async () => {
      const transactions = makeClient(PRIVATE_KEY);
      const input = {
        acceptance_token: "eyJhb...",
        accept_personal_auth: "eyJwZXJz...",
        amount_in_cents: 3000000,
        currency: "COP",
        signature: "sig_123",
        customer_email: "test@example.com",
        reference: "ref-123",
        payment_method: { type: "CARD", token: "tok_123", installments: 2 },
      };

      mockFetch.mockResolvedValueOnce(okJson(TRANSACTION_RESPONSE));

      const [error, data] = await transactions.createTransaction(input);

      expect(error).toBeNull();
      expect(data!.id).toBe("txn-123");
      const [, options] = mockFetch.mock.calls[0]!;
      expect(options.headers.Authorization).toBe(`Bearer ${PUBLIC_KEY}`);
    });

    it("should use private key when payment_source_id is provided", async () => {
      const transactions = makeClient(PRIVATE_KEY);

      mockFetch.mockResolvedValueOnce(okJson(TRANSACTION_RESPONSE));

      const [error] = await transactions.createTransaction({
        acceptance_token: "eyJhb...",
        accept_personal_auth: "eyJwZXJz...",
        amount_in_cents: 3000000,
        currency: "COP",
        signature: "sig_123",
        customer_email: "test@example.com",
        reference: "ref-123",
        payment_source_id: 1234,
      });

      expect(error).toBeNull();
      const [, options] = mockFetch.mock.calls[0]!;
      expect(options.headers.Authorization).toBe(`Bearer ${PRIVATE_KEY}`);
    });

    it("should return [error, null] when using payment_source_id without private key", async () => {
      const transactions = makeClient(undefined);

      const [error, data] = await transactions.createTransaction({
        acceptance_token: "eyJhb...",
        accept_personal_auth: "eyJwZXJz...",
        amount_in_cents: 3000000,
        currency: "COP",
        signature: "sig_123",
        customer_email: "test@example.com",
        reference: "ref-123",
        payment_source_id: 1234,
      });

      expect(data).toBeNull();
      expect(error!.message).toContain("Private key is required");
    });

    it("should reject input that provides neither payment_method nor payment_source_id", async () => {
      const transactions = makeClient(PRIVATE_KEY);

      const [error, data] = await transactions.createTransaction({
        acceptance_token: "eyJhb...",
        accept_personal_auth: "eyJwZXJz...",
        amount_in_cents: 3000000,
        currency: "COP",
        signature: "sig_123",
        customer_email: "test@example.com",
        reference: "ref-123",
      });

      expect(data).toBeNull();
      expect(error).toBeInstanceOf(WompiError);
      expect(error!.message).toContain("Invalid input");
    });

    it("accepts payment_method alongside payment_source_id (recurring card charge)", async () => {
      const transactions = makeClient(PRIVATE_KEY);

      // Wompi requires `payment_method.installments` when charging a saved
      // CARD source, so both fields travel together. `type` is omitted — the
      // source defines it.
      mockFetch.mockResolvedValueOnce(
        okJson({ data: { id: "tx-1", status: "PENDING", reference: "ref-123" } }, 201)
      );

      const [error, data] = await transactions.createTransaction({
        acceptance_token: "eyJhb...",
        accept_personal_auth: "eyJwZXJz...",
        amount_in_cents: 3000000,
        currency: "COP",
        signature: "sig_123",
        customer_email: "test@example.com",
        reference: "ref-123",
        payment_method: { installments: 1 },
        payment_source_id: 1234,
      });

      expect(error).toBeNull();
      expect(data!.id).toBe("tx-1");

      const [, init] = mockFetch.mock.calls[0];
      expect(JSON.parse(init.body)).toMatchObject({
        payment_method: { installments: 1 },
        payment_source_id: 1234,
      });
      expect(init.headers.Authorization).toBe(`Bearer ${PRIVATE_KEY}`);
    });

    it("should reject a missing accept_personal_auth before any request is sent", async () => {
      const transactions = makeClient(PRIVATE_KEY);

      const [error, data] = await transactions.createTransaction({
        acceptance_token: "eyJhb...",
        amount_in_cents: 3000000,
        currency: "COP",
        signature: "sig_123",
        customer_email: "test@example.com",
        reference: "ref-123",
        payment_method: { type: "CARD", token: "tok_123", installments: 1 },
      });

      expect(data).toBeNull();
      expect(error).toBeInstanceOf(WompiError);
      expect(error!.message).toContain("accept_personal_auth");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should forward the second acceptance token and the optional documented fields", async () => {
      const transactions = makeClient(PRIVATE_KEY);

      mockFetch.mockResolvedValueOnce(okJson(TRANSACTION_RESPONSE));

      const [error] = await transactions.createTransaction({
        acceptance_token: "eyJhb...",
        accept_personal_auth: "eyJwZXJz...",
        amount_in_cents: 3000000,
        currency: "COP",
        signature: "sig_123",
        customer_email: "test@example.com",
        reference: "ref-123",
        payment_method: { type: "CARD", token: "tok_123", installments: 1 },
        taxes: [{ type: "VAT", amount_in_cents: 478000 }],
        ip: "190.0.0.1",
        recurrent: true,
        parent_transaction_id: "txn-parent",
      });

      expect(error).toBeNull();

      const [, options] = mockFetch.mock.calls[0]!;
      expect(JSON.parse(options.body)).toMatchObject({
        acceptance_token: "eyJhb...",
        accept_personal_auth: "eyJwZXJz...",
        taxes: [{ type: "VAT", amount_in_cents: 478000 }],
        ip: "190.0.0.1",
        recurrent: true,
        parent_transaction_id: "txn-parent",
      });
    });

    it("should forward undocumented fields instead of stripping them", async () => {
      const transactions = makeClient(PRIVATE_KEY);

      mockFetch.mockResolvedValueOnce(okJson(TRANSACTION_RESPONSE));

      const [error] = await transactions.createTransaction({
        acceptance_token: "eyJhb...",
        accept_personal_auth: "eyJwZXJz...",
        amount_in_cents: 3000000,
        currency: "COP",
        signature: "sig_123",
        customer_email: "test@example.com",
        reference: "ref-123",
        payment_method: { type: "CARD", token: "tok_123", installments: 1 },
        future_field_wompi_added: "keep me",
      });

      expect(error).toBeNull();

      const [, options] = mockFetch.mock.calls[0]!;
      expect(JSON.parse(options.body)).toMatchObject({ future_field_wompi_added: "keep me" });
    });

    it("should return [error, null] on invalid input", async () => {
      const transactions = makeClient(PRIVATE_KEY);

      const [error, data] = await transactions.createTransaction({
        amount_in_cents: -5,
      });

      expect(data).toBeNull();
      expect(error).toBeInstanceOf(WompiError);
      expect(error!.message).toContain("Invalid input");
    });
  });

  describe("voidTransaction", () => {
    it("should return [null, data] wrapping the voided transaction", async () => {
      const transactions = makeClient(PRIVATE_KEY);

      // Wompi wraps the void outcome: a top-level `status` plus the voided
      // transaction nested under `data.transaction`.
      mockFetch.mockResolvedValueOnce(
        okJson({
          data: {
            status: "APPROVED",
            status_message: null,
            transaction: { ...TRANSACTION_RESPONSE.data, status: "VOIDED" },
          },
          meta: {},
        })
      );

      const [error, data] = await transactions.voidTransaction("txn-123", {
        amount_in_cents: 3000000,
      });

      expect(error).toBeNull();
      expect(data!.transaction?.id).toBe("txn-123");
      expect(data!.transaction?.status).toBe("VOIDED");
    });

    it("should return [null, undefined] on an empty 201 void response", async () => {
      const transactions = makeClient(PRIVATE_KEY);

      mockFetch.mockResolvedValueOnce(okEmpty());

      const [error, data] = await transactions.voidTransaction("txn-123");

      expect(error).toBeNull();
      expect(data).toBeUndefined();
    });

    it("should return [error, null] without private key", async () => {
      const transactions = makeClient(undefined);

      const [error, data] = await transactions.voidTransaction("txn-123");

      expect(data).toBeNull();
      expect(error!.message).toContain("Private key is required");
    });

    it("should allow void without body", async () => {
      const transactions = makeClient(PRIVATE_KEY);

      mockFetch.mockResolvedValueOnce(okEmpty());

      const [error] = await transactions.voidTransaction("txn-123");

      expect(error).toBeNull();
    });
  });
});
