---
"@pulgueta/wompi": minor
---

Support Wompi's second acceptance token: `accept_personal_auth` on
`createTransaction` / `createPaymentSource`, and `presigned_personal_data_auth`
on the merchant response. Input schemas no longer strip documented fields —
`taxes`, `ip`, `recurrent`, `parent_transaction_id` and `payment_description`
now reach the API. Payment-source `type` and `status` widened for `DAVIPLATA`,
`BANCOLOMBIA_TRANSFER` and `VOIDED`.
