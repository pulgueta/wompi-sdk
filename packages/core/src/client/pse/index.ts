import { WompiRequest } from "@/index";
import { WompiClient } from "@/client";
import { WompiError } from "@/errors/wompi-error";
import type { FinantialInstitutions } from "./types";

export class PSE extends WompiRequest {
  private readonly client: WompiClient;

  constructor(
    private readonly wompiClient: WompiClient,
    private readonly authorizationToken: string
  ) {
    super();

    this.client = wompiClient;
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
