---
"@pulgueta/wompi": minor
---

Support Wompi's second acceptance token: `accept_personal_auth` on
`createTransaction` / `createPaymentSource`, and `presigned_personal_data_auth`
on the merchant response. Both tokens are now **required** on those two
inputs — a request without `accept_personal_auth` is rejected locally with
`Invalid input` before anything is sent, matching Wompi's contract. Read the
token from `merchant.presigned_personal_data_auth.acceptance_token` and show
its `permalink` next to the terms link. Input schemas no longer strip documented fields —
`taxes`, `ip`, `recurrent`, `parent_transaction_id` and `payment_description`
now reach the API. Payment-source `type` and `status` widened for `DAVIPLATA`,
`BANCOLOMBIA_TRANSFER` and `VOIDED`.
