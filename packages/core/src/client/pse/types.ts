export type FinantialInstitutions = {
  readonly data: Datum[];
  readonly meta: Meta;
};

export type Datum = {
  readonly financial_institution_code: string;
  readonly financial_institution_name: string;
};

export type Meta = object;
