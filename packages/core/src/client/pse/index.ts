import { WompiClient } from "@/client";
import { WompiError } from "@/errors/wompi-error";
import type { FinantialInstitutions } from "./types";

export class PSE extends WompiClient {
  constructor(
    readonly client: WompiClient,
    readonly authorizationToken: string
  ) {
    super(client.getClientCredentials());
  }

  async getFinantialInstitutions() {
    const request = await this.get<FinantialInstitutions>("/pse/financial_institutions", {
      Authorization: this.authorizationToken,
    });

    if (!request) {
      throw new WompiError("Financial institutions not found");
    }

    return request;
  }
}
