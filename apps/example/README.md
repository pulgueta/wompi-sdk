# PanaBarbero — Wompi SDK showcase

A barbershop-supplies store that runs the full `@pulgueta/wompi` surface against the Colombia sandbox. Checkout and payouts live in TanStack Start server functions; Convex backs **only** the AI assistant.

- **Vista Cliente** — cart plus buyer form, then a server-signed Wompi Web Checkout with the buyer's data prefilled (`customer-data:*`). The amount is recomputed on the server from the catalog and bound to the order reference with an HMAC proof. The final status arrives through the `transaction.updated` webhook (`/api/checkout-webhook`); until it lands, the result dialog polls the backend, which reconciles against the Wompi API.
- **Vista Administrador** — BRE-B payouts to suppliers: resolve the key in the directory (masked holder), create the dispersion, and watch the payout settle. Sandbox error keys (`noexiste@test.com`, `12345`, `inactiva@test.com`, `timeout@test.com`, `error@test.com`) exercise every failure path, and the `APROBADA / FALLIDA` toggle maps to the sandbox `transactionStatus` simulation. A `TOTAL_PAYMENT` batch settles the provider's pending balance exactly once, whether the webhook (`/api/payouts-webhook`) or the status poll wins the race.
- **Asistente Wompi** — a Convex AI Agent (`@convex-dev/agent`) with RAG (`@convex-dev/rag`) over the SDK docs (`apps/docs/content`) that answers integration questions with sources. This is the only feature backed by Convex.

Secrets never reach the browser: checkout signing, payout credentials, and webhook verification all live in server functions and API routes. Provider balances and tracked dispersions are in-memory demo state — a dev-server restart reseeds them.

## Setup

```bash
cp apps/example/.env.example apps/example/.env.local
```

- `WOMPI_PUBLIC_KEY`, `WOMPI_INTEGRITY_KEY`, and `WOMPI_EVENTS_KEY` come from the regular Payments integration.
- `WOMPI_PAYOUTS_API_KEY`, `WOMPI_PAYOUTS_USER_PRINCIPAL_ID`, and `WOMPI_PAYOUTS_EVENTS_KEY` come from **Pagos a Terceros**.
- `CONVEX_DEPLOYMENT` / `VITE_CONVEX_URL` bind the AI assistant to its Convex deployment (`npx convex dev` creates one if you start fresh). The store works without them — the chat widget just stays hidden.

The assistant's Vercel AI Gateway key lives on the Convex deployment:

```bash
cd apps/example
npx convex env set AI_GATEWAY_API_KEY vck_...
npx convex env set AI_GATEWAY_CHAT_MODEL zai/glm-5.2                    # optional, this is the default
npx convex env set AI_GATEWAY_EMBEDDING_MODEL openai/text-embedding-3-small  # optional, this is the default
```

Both model ids need the provider prefix — an id without it fails against the AI Gateway. The RAG index is fixed at 1,536 dimensions (`embeddingDimension` in `convex/rag.ts`), so `AI_GATEWAY_EMBEDDING_MODEL` must be a 1,536-dimension model — `openai/text-embedding-3-small` (default) or `openai/text-embedding-ada-002`. A model with another output size needs a matching `embeddingDimension` change. Either change invalidates the index: re-ingest the corpus afterwards.

Install dependencies from the monorepo root, then provision and run the example:

```bash
pnpm install
cd apps/example
npx convex dev --once   # configures the deployment and pushes the agent once
pnpm dev                # app on :3000; also starts the Convex watcher
```

Ingest the docs corpus for the assistant once:

```bash
pnpm ingest-docs        # local repository docs
pnpm ingest-wompi-docs  # 60 official docs.wompi.co pages
```

`ingest-wompi-docs` fetches the official pages as markdown, so it requires
network access and the local `curl.md` helper on `PATH`.

Each document is tagged with a section (`getting-started`, `checkout`, `events`, `payouts`, `plugins`, `reports`, `sdk`) so the assistant can narrow a search. A corpus ingested before the tag existed has no sections — re-ingest to get the filter.

### `stopWhen` trap

`@convex-dev/agent` stops after the first tool call unless the agent sets `stopWhen: stepCountIs(n)`. Without it the run ends with `finishReason: "tool-calls"`, no answer is written, and the UI shows empty bubbles. See `stopWhen: stepCountIs(8)` in `convex/chat.ts`.

## Webhooks

Both event URLs live on the app itself, so simulating approved and failed transactions end-to-end needs a public origin (any HTTPS tunnel to :3000 works — set `WOMPI_EXAMPLE_ORIGIN` to it). In the Wompi sandbox dashboard configure:

| Dashboard section          | URL                                        |
| -------------------------- | ------------------------------------------ |
| Eventos (Payments)         | `<origin>/api/checkout-webhook`            |
| Eventos (Pagos a Terceros) | `<origin>/api/payouts-webhook`             |

Every delivery is checksum-verified (`WOMPI_EVENTS_KEY` / `WOMPI_PAYOUTS_EVENTS_KEY`) before the payload is trusted. Without a tunnel the flows still complete: the UI polls the server, which reconciles against the Wompi API.

## Sandbox data

Approved Web Checkout card: `4242 4242 4242 4242` (any future expiry, any CVC). Declined: `4111 1111 1111 1111`.

Successful BRE-B keys: `@elias123`, `ecolon@wompi.com`, `3001234567`, `1020304050`, `B00012345`, `900123456`.
