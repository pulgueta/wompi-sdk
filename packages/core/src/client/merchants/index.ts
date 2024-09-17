import { WompiClient } from "@/client";
import type { AcceptanceTokenResponse } from "./types";

export class Merchants extends WompiClient {
  constructor(readonly client: WompiClient) {
    super(client.getClientCredentials());
  }

  async authenticate() {
    const query = await this.get<AcceptanceTokenResponse>(`/merchants/${this.publicKey}`);

    return query;
  }
}
