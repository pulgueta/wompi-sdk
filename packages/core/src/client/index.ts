import { WompiError } from "@/errors/wompi-error";
import { Merchants } from "@/client/merchants";
import { Transactions } from "@/client/transactions";
import { PSE } from "@/client/pse";

type WompiClientOptions = {
  publicKey: string;
  publicEventsKey: string;
  eventsUrl: string;
};

export class WompiClient {
  protected readonly publicKey: string;
  protected readonly publicEventsKey: string;
  protected readonly eventsUrl: string;

  private readonly merchants: Merchants;
  readonly transactions: Transactions;
  readonly pse: PSE;

  constructor(private readonly options: WompiClientOptions) {
    if (!options) {
      throw new WompiError("Please provide the required credentials");
    }

    this.publicKey = options.publicKey;
    this.publicEventsKey = options.publicEventsKey;
    this.eventsUrl = options.eventsUrl;

    this.merchants = new Merchants(this.publicKey);
    this.transactions = new Transactions(`Bearer ${this.publicKey}`);
    this.pse = new PSE(`Bearer ${this.publicKey}`);
  }
}
