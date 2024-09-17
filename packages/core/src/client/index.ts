import { WompiRequest } from "@/index";
import { WompiError } from "@/errors/wompi-error";

import { Merchants } from "@/client/merchants";
import { Transactions } from "@/client/transactions";
import { PSE } from "@/client/pse";

type WompiRequestOptions = {
  publicKey: string;
  publicEventsKey: string;
  eventsUrl: string;
};

export class WompiClient extends WompiRequest {
  protected readonly publicKey: string;
  protected readonly publicEventsKey: string;
  protected readonly eventsUrl: string;

  private readonly merchants: Merchants;
  readonly transactions: Transactions;
  readonly pse: PSE;

  constructor(private options: WompiRequestOptions) {
    super();

    if (!options) {
      throw new WompiError("Please provide the required credentials");
    }

    this.publicKey = options.publicKey;
    this.publicEventsKey = options.publicEventsKey;
    this.eventsUrl = options.eventsUrl;

    this.merchants = new Merchants(this);
    this.transactions = new Transactions(this, `Bearer ${this.publicKey}`);
    this.pse = new PSE(this, `Bearer ${this.publicKey}`);
  }

  getClientCredentials() {
    return {
      publicKey: this.publicKey,
      publicEventsKey: this.publicEventsKey,
      eventsUrl: this.eventsUrl,
    };
  }
}
