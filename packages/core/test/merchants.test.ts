import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WompiClient } from "../src";
import { okJson } from "./helpers";

const MERCHANT_RESPONSE = {
  data: {
    id: 11000,
    name: "Tienda del ahorro",
    legal_name: "Mi Tienda S.A.S.",
    legal_id: "9001723102-4",
    legal_id_type: "NIT",
    phone_number: "5712134489",
    active: true,
    logo_url: null,
    email: "admin@mitienda.com.co",
    contact_name: "Pedro Perez",
    public_key: "pub_test_123",
    accepted_payment_methods: ["CARD", "NEQUI", "PSE"],
    accepted_currencies: ["COP"],
    presigned_acceptance: {
      acceptance_token: "eyJhb...",
      permalink: "https://wompi.co/terms",
      type: "END_USER_POLICY",
    },
    presigned_personal_data_auth: {
      acceptance_token: "eyJwZXJz...",
      permalink: "https://wompi.co/personal-data",
      type: "PERSONAL_DATA_AUTH",
    },
  },
};

describe("Merchants", () => {
  const mockFetch = vi.fn();
  const PUBLIC_KEY = "pub_test_123";

  const makeClient = (sandbox = true) =>
    new WompiClient({ publicKey: PUBLIC_KEY, sandbox }).merchants;

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("getMerchant", () => {
    it("should return [null, data] with merchant info", async () => {
      const merchants = makeClient();

      mockFetch.mockResolvedValueOnce(okJson(MERCHANT_RESPONSE));

      const [error, data] = await merchants.getMerchant();

      expect(error).toBeNull();
      expect(data!.id).toBe(11000);
      expect(data!.name).toBe("Tienda del ahorro");
      expect(data!.accepted_payment_methods).toEqual(["CARD", "NEQUI", "PSE"]);

      const [url, options] = mockFetch.mock.calls[0]!;
      expect(url).toContain(`/merchants/${PUBLIC_KEY}`);
      expect(options.method).toBe("GET");
    });

    it("should expose both presigned acceptance tokens", async () => {
      const merchants = makeClient();

      mockFetch.mockResolvedValueOnce(okJson(MERCHANT_RESPONSE));

      const [error, data] = await merchants.getMerchant();

      expect(error).toBeNull();
      expect(data!.presigned_acceptance).toEqual({
        acceptance_token: "eyJhb...",
        permalink: "https://wompi.co/terms",
        type: "END_USER_POLICY",
      });
      expect(data!.presigned_personal_data_auth).toEqual({
        acceptance_token: "eyJwZXJz...",
        permalink: "https://wompi.co/personal-data",
        type: "PERSONAL_DATA_AUTH",
      });
    });

    it("should accept payment methods outside the strict enum", async () => {
      const merchants = makeClient();

      // The live sandbox returns these for real merchants — they must not fail validation.
      mockFetch.mockResolvedValueOnce(
        okJson({
          data: {
            ...MERCHANT_RESPONSE.data,
            accepted_payment_methods: ["DAVIPLATA", "BANCOLOMBIA_BNPL", "SU_PLUS", "CARD_POS"],
          },
        })
      );

      const [error, data] = await merchants.getMerchant();

      expect(error).toBeNull();
      expect(data!.accepted_payment_methods).toContain("DAVIPLATA");
    });

    it("should accept a partial merchant body without a false error", async () => {
      const merchants = makeClient();

      mockFetch.mockResolvedValueOnce(okJson({ data: { id: 11000, public_key: "pub_test_123" } }));

      const [error, data] = await merchants.getMerchant();

      expect(error).toBeNull();
      expect(data!.id).toBe(11000);
    });

    it("should use sandbox URL when sandbox is enabled", async () => {
      const merchants = makeClient(true);

      mockFetch.mockResolvedValueOnce(okJson(MERCHANT_RESPONSE));

      await merchants.getMerchant();

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toContain("sandbox.wompi.co");
    });

    it("should use production URL when sandbox is disabled", async () => {
      const merchants = makeClient(false);

      mockFetch.mockResolvedValueOnce(okJson(MERCHANT_RESPONSE));

      await merchants.getMerchant();

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toContain("production.wompi.co");
    });
  });
});
