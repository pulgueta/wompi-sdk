import type { PaymentProcessor } from "@/types/payment-method-type";
import type { TransactionStatus } from "@/types/status";

export type TransactionResponse = {
  readonly data: Data;
  readonly meta: Meta;
};

export type Data = {
  readonly id: string;
  readonly created_at: Date;
  readonly finalized_at: null;
  readonly amount_in_cents: number;
  readonly reference: string;
  readonly customer_email: string;
  readonly currency: string;
  readonly payment_method_type: string;
  readonly payment_method: PaymentMethod;
  readonly status: Status;
  readonly status_message: null;
  readonly billing_data: null;
  readonly shipping_address: ShippingAddress;
  readonly redirect_url: null;
  readonly payment_source_id: null;
  readonly payment_link_id: null;
  readonly customer_data: CustomerData;
  readonly bill_id: null;
  readonly taxes: unknown[];
  readonly tip_in_cents: null;
  readonly merchant?: Merchant;
};

export type Status = "APPROVED" | "DECLINED" | "PENDING";

export type CustomerData = {
  readonly legal_id: string;
  readonly full_name: string;
  readonly phone_number: string;
  readonly legal_id_type: string;
};

export type Merchant = {
  readonly id: number;
  readonly name: string;
  readonly legal_name: string;
  readonly contact_name: string;
  readonly phone_number: string;
  readonly logo_url: null;
  readonly legal_id_type: string;
  readonly email: string;
  readonly legal_id: string;
  readonly public_key: string;
};

export type PaymentMethod = {
  readonly type: string;
  readonly extra: Extra;
  readonly installments: number;
};

export type Extra = {
  readonly bin: string;
  readonly name: string;
  readonly brand: string;
  readonly exp_year: string;
  readonly card_type: string;
  readonly exp_month: string;
  readonly last_four: string;
  readonly card_holder: string;
  readonly is_three_ds: boolean;
};

export type ShippingAddress = {
  readonly address_line_1: string;
  readonly address_line_2: string;
  readonly country: string;
  readonly region: string;
  readonly city: string;
  readonly name: string;
  readonly phone_number: string;
  readonly postal_code: string;
};

export type Meta = object;

export type YYYYMMDD = `${number}${number}${number}${number}-${number}${number}-${number}${number}`;

export type TransactionParameters = {
  readonly reference: string;
  readonly from_date?: YYYYMMDD;
  readonly until_date?: YYYYMMDD;
  readonly page?: number;
  readonly page_size?: number;
  readonly id: string;
  readonly payment_method_type: PaymentProcessor;
  readonly status: TransactionStatus;
  readonly customer_email: string;
  readonly order_by?: string;
  readonly order?: "DESC" | "ASC";
};
