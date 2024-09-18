import { WompiError } from "@/errors/wompi-error";

type WompiServerOptions = {
  privateKey: string;
  privateEventsKey: string;
  eventsUrl: string;
};

export class WompiServer {
  protected readonly privateKey: string;
  protected readonly privateEventsKey: string;
  protected readonly eventsUrl: string;

  constructor(private readonly options: WompiServerOptions) {
    if (!options) {
      throw new WompiError("Please provide the required credentials");
    }

    this.privateKey = options.privateKey;
    this.privateEventsKey = options.privateEventsKey;
    this.eventsUrl = options.eventsUrl;
  }
}
