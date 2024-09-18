export type AcceptanceTokenResponse = {
  readonly data: Data;
  readonly meta: Meta;
};

export type Data = {
  readonly id: number;
  readonly name: string;
  readonly email: string;
  readonly contact_name: string;
  readonly phone_number: string;
  readonly active: boolean;
  readonly logo_url: string | null;
  readonly legal_name: string;
  readonly legal_id_type: string;
  readonly legal_id: string;
  readonly public_key: string;
  readonly accepted_currencies: string[];
  readonly fraud_javascript_key: string | null;
  readonly fraud_groups: unknown[];
  readonly accepted_payment_methods: string[];
  readonly payment_methods: PaymentMethod[];
  readonly presigned_acceptance: PresignedAcceptance;
};

export type PaymentMethod = {
  readonly name: string;
  readonly payment_processors: PaymentProcessor[];
};

export type PaymentProcessor = {
  readonly name: string;
};

export type PresignedAcceptance = {
  readonly acceptance_token: string;
  readonly permalink: string;
  readonly type: string;
};

export type Meta = object;
