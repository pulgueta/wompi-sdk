import { describe, it, expect } from "vitest";
import { WompiClient } from "../../src";
import { getSignatureKey } from "../../src/server";
import { WompiNotFoundError } from "../../src/schemas";

/**
 * Transaction lifecycle against the real Wompi sandbox: tokenize a card, sign
 * the amount, create the transaction, poll until it settles, then void it.
 *
 * Gated on the three credentials a write flow needs. See `read.test.ts` for how
 * to supply them; the default `pnpm test` / CI run skips this suite. The client
 * is built lazily because `describe.skipIf` still runs the describe body.
 */
const publicKey = process.env.WOMPI_PUBLIC_KEY;
const privateKey = process.env.WOMPI_PRIVATE_KEY;
const integrityKey = process.env.WOMPI_INTEGRITY_KEY;
const canRun = Boolean(publicKey && privateKey && integrityKey);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const sandboxClient = () =>
  new WompiClient({
    publicKey: publicKey ?? "",
    privateKey,
    sandbox: true,
  });

describe.skipIf(!canRun)("sandbox · transaction lifecycle", () => {
  it("creates a transaction with a getSignatureKey signature, reads it, then voids it", async () => {
    const wompi = sandboxClient();

    // 1. Both acceptance tokens from the merchant.
    const [merchantError, merchant] = await wompi.merchants.getMerchant();
    expect(merchantError).toBeNull();
    const acceptanceToken = merchant?.presigned_acceptance?.acceptance_token;
    const personalAuthToken = merchant?.presigned_personal_data_auth?.acceptance_token;
    expect(acceptanceToken).toBeTruthy();
    expect(personalAuthToken).toBeTruthy();

    // 2. Tokenize the approved test card.
    const [tokenError, token] = await wompi.tokens.tokenizeCard({
      number: "4242424242424242",
      cvc: "123",
      exp_month: "12",
      exp_year: "29",
      card_holder: "Pedro Pérez",
    });
    expect(tokenError).toBeNull();
    expect(token?.id).toBeTruthy();

    // 3. Sign the exact reference + amount with the integrity key.
    const reference = `sdk-it-${Date.now()}`;
    const amountInCents = 150_000;
    const signature = await getSignatureKey({
      reference,
      amountInCents,
      integrityKey: integrityKey ?? "",
    });

    // 4. Create the transaction.
    const [createError, created] = await wompi.transactions.createTransaction({
      acceptance_token: acceptanceToken,
      accept_personal_auth: personalAuthToken,
      amount_in_cents: amountInCents,
      currency: "COP",
      signature,
      customer_email: "buyer@example.com",
      reference,
      payment_method: {
        type: "CARD",
        token: token?.id,
        installments: 1,
      },
    });
    expect(createError).toBeNull();
    const transactionId = created?.id;
    expect(transactionId).toBeTruthy();

    // 5. Poll until the sandbox settles the transaction.
    let status = created?.status;
    for (let attempt = 0; attempt < 20 && status === "PENDING"; attempt++) {
      await sleep(2_000);
      const [getError, fetched] = await wompi.transactions.getTransaction(transactionId ?? "");
      expect(getError).toBeNull();
      status = fetched?.status;
    }
    expect(status).toBeDefined();

    // 6. Void it once approved — the only state Wompi lets you void.
    if (status === "APPROVED") {
      const [voidError, voided] = await wompi.transactions.voidTransaction(transactionId ?? "");
      expect(voidError).toBeNull();
      expect(voided?.transaction?.id).toBe(transactionId);
    }
  }, 60_000);

  it("getTransaction on an unknown id resolves to a WompiNotFoundError", async () => {
    const [error, data] = await sandboxClient().transactions.getTransaction(
      "sdk-it-nonexistent-transaction-id"
    );

    expect(data).toBeNull();
    expect(error).toBeInstanceOf(WompiNotFoundError);
  });
});
