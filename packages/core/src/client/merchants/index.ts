import { WompiRequest } from "@/index";
import { WompiClient } from "@/client";
import type { AcceptanceTokenResponse } from "./types";

export class Merchants extends WompiRequest {
  constructor(
    readonly client: WompiClient,
    readonly publicKey: string
  ) {
    super();
  }

  async authenticate() {
    const query = await this.get<AcceptanceTokenResponse>(`/merchants/${this.publicKey}`);

    return query;
  }
}
