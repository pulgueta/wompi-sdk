export type WompiEndpoints = {
  get: {
    transactions: {
      all: string;
    };
  };
};

export type WompiGetEndpoint = keyof WompiEndpoints["get"]["transactions"];
