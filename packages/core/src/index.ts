export class WompiRequest {
  private readonly baseUrl: string =
    process.env.NODE_ENV === "development"
      ? "https://sandbox.wompi.co/v1"
      : "https://production.wompi.co/v1";

  private async request(
    method: "GET" | "POST" | "PATCH",
    endpoint: string,
    requestOptions: Omit<RequestInit, "method"> = {}
  ) {
    const r = await fetch(`${this.baseUrl}${endpoint}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...requestOptions.headers,
      },
    });

    const data = await r.json();

    return data;
  }

  protected async get<const T>(endpoint: string, headers?: RequestInit["headers"]) {
    const req = await this.request("GET", endpoint, { headers });

    return req as T;
  }

  protected async post<const T>(endpoint: string) {
    const req = await this.request("POST", endpoint);

    return req as T;
  }

  protected async patch<const T>(endpoint: string) {
    const req = await this.request("PATCH", endpoint);

    return req as T;
  }
}
