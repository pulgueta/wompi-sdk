import { WompiClient } from "@/client";
import type { TransactionParameters, TransactionResponse } from "./types";
import { createYYYYMMDD, isValidYYYYMMDD } from "./types";
import { WompiError } from "@/errors/wompi-error";

export class Transactions extends WompiClient {
  private readonly headers: RequestInit["headers"] = {
    Authorization: `Bearer ${this.publicKey}`,
  };

  constructor(readonly client: WompiClient) {
    super(client.getClientCredentials());
  }

  async getTransaction(id: string) {
    const transaction = await this.get<TransactionResponse>(`/transactions/${id}`, this.headers);

    if (!transaction) {
      throw new WompiError(`Transaction with id ${id} not found`);
    }

    return transaction;
  }

  async getTransactions({
    customer_email,
    from_date = createYYYYMMDD(new Date(new Date().getDay() - 1)),
    until_date = createYYYYMMDD(new Date(new Date().getMonth() + 1)),
    id,
    order = "ASC",
    order_by = "created_at",
    page = 1,
    page_size = 15,
    payment_method_type,
    reference,
    status,
  }: TransactionParameters) {
    if (!isValidYYYYMMDD(from_date) || !isValidYYYYMMDD(until_date)) {
      throw new WompiError("Invalid date format, must be of type YYYY-MM-DD");
    }

    if (page < 1) {
      throw new WompiError("Page cannot be less than 1");
    }

    if (page > 1000000) {
      throw new WompiError("Page cannot be greater than 1000000");
    }

    if (page_size > 200) {
      throw new WompiError("Page size cannot be greater than 200");
    }

    const transactions = await this.get<TransactionResponse[]>(
      `/transactions?from_date=${from_date}&page=${page}&page_size=${page_size}&until_date=${until_date}&id=${id}&order=${order}&order_by=${order_by}&payment_method_type=${payment_method_type}&reference=${reference}&status=${status}&customer_email=${customer_email}`,
      this.headers
    );

    if (!transactions) {
      throw new WompiError("Transactions not found");
    }

    return transactions;
  }
}
