import { WompiRequest } from "@/index";
import { WompiError } from "@/errors/wompi-error";
import type { FinantialInstitutions } from "./types";

export class PSE extends WompiRequest {
  constructor(private readonly authorizationToken: string) {
    super();
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
