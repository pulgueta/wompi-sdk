"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import type { FunctionReference } from "convex/server";
import { WompiClient } from "@pulgueta/wompi";
import type { CardToken } from "@pulgueta/wompi/schemas";

export type WompiCheckoutConfig = {
  publicKey: string;
  sandbox: boolean;
  currency: string;
};

export type CardInput = {
  number: string;
  cvc: string;
  expMonth: string;
  expYear: string;
  cardHolder: string;
};

type GetConfigRef = FunctionReference<
  "query",
  "public",
  Record<string, never>,
  WompiCheckoutConfig
>;

/**
 * Browser-side card tokenization against Wompi — card data goes straight
 * from the browser to Wompi's API with your public key and never touches
 * your backend (the PCI-friendly path). Pass the resulting token id to the
 * `subscribe` action.
 *
 * ```tsx
 * const { tokenizeCard, acceptancePermalink, personalDataAuthPermalink, ready } =
 *   useWompiTokenizer(api.wompi.getConfig);
 * const token = await tokenizeCard(card);
 * await subscribe({ productKey, token: token.id, paymentMethod: { ... } });
 * ```
 */
export function useWompiTokenizer(getConfig: GetConfigRef) {
  const config = useQuery(getConfig, {});
  const [acceptancePermalink, setAcceptancePermalink] = useState<string | null>(null);
  const [personalDataAuthPermalink, setPersonalDataAuthPermalink] = useState<string | null>(
    null,
  );

  const publicKey = config?.publicKey;
  const sandbox = config?.sandbox ?? false;

  const client = useMemo(() => {
    if (!publicKey) return null;
    return new WompiClient({ publicKey, sandbox });
  }, [publicKey, sandbox]);

  useEffect(() => {
    if (!client) return;
    let active = true;

    void client.merchants.getMerchant().then(([error, merchant]) => {
      if (!active || error) return;
      if (merchant.presigned_acceptance) {
        setAcceptancePermalink(merchant.presigned_acceptance.permalink);
      }
      if (merchant.presigned_personal_data_auth) {
        setPersonalDataAuthPermalink(merchant.presigned_personal_data_auth.permalink);
      }
    });

    return () => {
      active = false;
    };
  }, [client]);

  const tokenizeCard = useCallback(
    async (card: CardInput): Promise<CardToken> => {
      if (!client) {
        throw new Error("Wompi configuration has not loaded yet");
      }

      const [error, token] = await client.tokens.tokenizeCard({
        number: card.number.replaceAll(" ", ""),
        cvc: card.cvc,
        exp_month: card.expMonth,
        exp_year: card.expYear,
        card_holder: card.cardHolder,
      });

      if (error) throw error;
      return token;
    },
    [client],
  );

  return {
    /** False until the public config has loaded from Convex. */
    ready: client !== null,
    config: config ?? null,
    /** Link to Wompi's terms the user accepts when saving a payment method. */
    acceptancePermalink,
    /**
     * Link to Wompi's personal-data authorization (habeas data). Show both
     * links: `subscribe` sends both acceptance tokens on the user's behalf.
     */
    personalDataAuthPermalink,
    tokenizeCard,
  };
}
