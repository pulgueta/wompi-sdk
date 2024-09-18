import { WompiRequest } from "@/index";
import { WompiError } from "@/errors/wompi-error";
import type { TransactionParameters, TransactionResponse } from "./types";
import { createYYYYMMDD, isValidYYYYMMDD } from "@/client/utils/date-format";

export class Transactions extends WompiRequest {
  constructor(private readonly authorizationToken: string) {
    super();
  }

  async getTransaction(id: string) {
    const transaction = await this.get<TransactionResponse>(`/transactions/${id}`, {
      Authorization: this.authorizationToken,
    });

    if (!transaction) {
      throw new WompiError(`Transaction with id ${id} not found`);
    }

    return transaction;
  }

  async getTransactions(params: TransactionParameters) {
    this.validateTransactionParams(params);

    const queryUrl = this.buildQueryUrl(params);

    const transactions = await this.get<TransactionResponse[]>(queryUrl, {
      Authorization: this.authorizationToken,
    });

    if (transactions.length === 0) {
      return [];
    }

    return transactions;
  }

  private validateTransactionParams(params: TransactionParameters) {
    const fromYesterday = createYYYYMMDD(new Date(Date.now() - 86400000));
    const untilAMonthFromYesterday = createYYYYMMDD(new Date(Date.now() + 2592000000));

    const {
      from_date = fromYesterday,
      until_date = untilAMonthFromYesterday,
      page = 1,
      page_size = 30,
    } = params;

    if (!isValidYYYYMMDD(from_date) || !isValidYYYYMMDD(until_date)) {
      throw new WompiError("Invalid date format, must be of type YYYY-MM-DD");
    }

    if (page < 1 || page > 1000000) {
      throw new WompiError("Page must be between 1 and 1,000,000");
    }

    if (page_size < 1 || page_size > 200) {
      throw new WompiError("Page size must be between 1 and 200");
    }
  }

  private buildQueryUrl(params: TransactionParameters) {
    const {
      customer_email,
      from_date = createYYYYMMDD(new Date(Date.now() - 86400000)),
      until_date = createYYYYMMDD(new Date(Date.now() + 2592000000)),
      id,
      order,
      order_by,
      page = 1,
      page_size = 15,
      payment_method_type,
      reference,
      status,
    } = params;

    const queryParams = new URLSearchParams({
      from_date,
      until_date,
      page: page.toString(),
      page_size: page_size.toString(),
    });

    if (id) queryParams.append("id", id);
    if (order) queryParams.append("order", order);
    if (order_by) queryParams.append("order_by", order_by);
    if (payment_method_type) queryParams.append("payment_method_type", payment_method_type);
    if (reference) queryParams.append("reference", reference);
    if (status) queryParams.append("status", status);
    if (customer_email) queryParams.append("customer_email", customer_email);

    return `/transactions?${queryParams.toString()}`;
  }
}
