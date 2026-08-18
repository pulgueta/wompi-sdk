import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { gateway } from "ai";
import { jsonSchema, stepCountIs } from "ai";
import {
  Agent,
  createThread as createAgentThread,
  createTool,
  getThreadMetadata,
  listUIMessages,
  saveMessage,
  syncStreams,
  updateThreadMetadata,
  vStreamArgs,
} from "@convex-dev/agent";
import { HOUR, MINUTE, RateLimiter } from "@convex-dev/rate-limiter";
import { internalAction, mutation, query } from "./_generated/server";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { components, internal } from "./_generated/api";
import { DOC_SECTIONS, rag, WOMPI_DOCS_NAMESPACE } from "./rag";
import type { DocSection } from "./rag";

const CHAT_MODEL = process.env.AI_GATEWAY_CHAT_MODEL ?? "zai/glm-5.2";
const DEMO_USER_ID = "panabarbero-demo";
const DEFAULT_THREAD_TITLE = "Asistente Wompi";
const AGENT_NAME = DEFAULT_THREAD_TITLE;
const MAX_PROMPT_CHARS = 4000;
const MAX_DOC_CHARS = 16_000;

const rateLimiter = new RateLimiter(components.rateLimiter, {
  createThread: { kind: "token bucket", rate: 30, period: HOUR },
  sendMessageGlobal: { kind: "token bucket", rate: 100, period: HOUR },
  sendMessagePerThread: {
    kind: "token bucket",
    rate: 5,
    period: MINUTE,
    capacity: 5,
  },
});

// ---------------------------------------------------------------------------
// Curated SDK snippets. Convex functions can't read from disk at runtime, so
// the surface of @pulgueta/wompi is embedded here (sourced from
// packages/core/README.md).
// ---------------------------------------------------------------------------

const SDK_EXAMPLES: Record<string, string> = {
  cliente: `### Crear el cliente (@pulgueta/wompi)

Solo \`publicKey\` es obligatoria; \`privateKey\` habilita los endpoints privados
y \`sandbox\` apunta al ambiente de pruebas.

\`\`\`ts
import { WompiClient } from "@pulgueta/wompi";

const wompi = new WompiClient({
  publicKey: process.env.WOMPI_PUBLIC_KEY!,
  privateKey: process.env.WOMPI_PRIVATE_KEY, // opcional
  sandbox: true, // opcional, por defecto false (producción)
});
\`\`\`

Todos los métodos devuelven una tupla error-first \`[error, data]\` en lugar de lanzar:

\`\`\`ts
const [error, tx] = await wompi.transactions.getTransaction("txn-id");
if (error) console.error(error.message); // WompiError / WompiNotFoundError / WompiValidationError
else console.log(tx.status);
\`\`\``,

  checkout: `### URL de Web Checkout con firma de integridad y autofill

\`buildCheckoutUrl\` calcula la firma SHA-256 y agrega los parámetros
\`customer-data:*\` para prellenar el formulario del comprador. Nunca la llames
con \`integrityKey\` desde el navegador.

\`\`\`ts
import { buildCheckoutUrl } from "@pulgueta/wompi/server";

const url = await buildCheckoutUrl({
  publicKey: process.env.WOMPI_PUBLIC_KEY!,
  reference: "order-1042", // referencia única del comercio
  amountInCents: 8_900_000, // ya en centavos, no multiplicar
  redirectUrl: "https://example.com/orders/1042", // vuelve con ?id=<transactionId>
  integrityKey: process.env.WOMPI_INTEGRITY_KEY!,
  customerData: {
    email: "camila@correo.co",
    fullName: "Camila Ríos",
    phoneNumber: "3001234567",
    phoneNumberPrefix: "+57",
    legalId: "1023456789",
    legalIdType: "CC",
  },
});
\`\`\`

La firma también puede calcularse sola con \`getSignatureKey({ reference, amountInCents, integrityKey })\`.`,

  webhooks: `### Verificar webhooks transaction.updated

Wompi firma cada evento con la llave de eventos; \`verifyWebhookEvent\` valida el
checksum antes de confiar en el payload.

\`\`\`ts
import { verifyWebhookEvent, isTransactionUpdatedEvent } from "@pulgueta/wompi/server";

const body = await request.text();
const [error, event] = await verifyWebhookEvent(body, {
  eventsKey: process.env.WOMPI_EVENTS_KEY!,
});
if (error) return new Response("Invalid signature", { status: 403 });

if (isTransactionUpdatedEvent(event)) {
  const tx = event.data.transaction;
  // tx.reference, tx.status ("APPROVED" | "DECLINED" | ...), tx.amount_in_cents
}
\`\`\`

En este demo los webhooks viven en la app TanStack Start:
\`/api/checkout-webhook\` (pagos) y \`/api/payouts-webhook\` (dispersiones).`,

  payouts: `### Payouts / dispersiones BRE-B (Pagos a Terceros)

La API de Payouts usa credenciales propias (\`x-api-key\` + \`user-principal-id\`).
Primero se puede resolver la llave BRE-B para confirmar el titular, y luego crear
el batch. En sandbox, \`transactionStatus\` fuerza el estado final.

\`\`\`ts
import { WompiPayoutsClient } from "@pulgueta/wompi";

const payouts = new WompiPayoutsClient({
  apiKey: process.env.WOMPI_PAYOUTS_API_KEY!,
  userPrincipalId: process.env.WOMPI_PAYOUTS_USER_PRINCIPAL_ID!,
  sandbox: true,
});

const [resolveError, holder] = await payouts.resolveBrebKey("@JUANPEREZ", "ALPHANUMERIC");
// holder.holderName llega parcialmente enmascarado por diseño

const [error, created] = await payouts.createPayout(
  {
    reference: "providers-2026-07",
    accountId: "<cuenta origen>",
    paymentType: "PROVIDERS",
    transactionStatus: "APPROVED", // solo sandbox: fuerza el estado final
    transactions: [
      { key: "@JUANPEREZ", name: "Juan Pérez", email: "juan@example.com", amount: 500_000 },
    ],
  },
  { idempotencyKey: "providers-2026-07" }, // único por 24h, evita duplicados
);
\`\`\`

Los eventos de Payouts llegan a su propia URL y se firman con
\`WOMPI_PAYOUTS_EVENTS_KEY\` (verificados con \`verifyPayoutEvent\`).`,
};

const SDK_TOPIC_ALIASES: Record<string, string> = {
  cliente: "cliente",
  client: "cliente",
  setup: "cliente",
  checkout: "checkout",
  "web-checkout": "checkout",
  firma: "checkout",
  integridad: "checkout",
  webhooks: "webhooks",
  webhook: "webhooks",
  eventos: "webhooks",
  payouts: "payouts",
  dispersiones: "payouts",
  dispersion: "payouts",
  "bre-b": "payouts",
  breb: "payouts",
};

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const searchWompiDocs = createTool({
  description:
    "Busca en la documentación oficial de Wompi y del SDK @pulgueta/wompi. Úsala SIEMPRE antes de responder cualquier pregunta. Puedes acotar la búsqueda a una sección con el parámetro section.",
  inputSchema: jsonSchema<{ query: string; section?: DocSection }>({
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Consulta en lenguaje natural sobre Wompi, sus APIs o el SDK",
      },
      section: {
        type: "string",
        enum: [...DOC_SECTIONS],
        description:
          "Sección opcional para acotar la búsqueda: getting-started (llaves, ambientes, transacciones, errores), checkout (widget, datos de prueba), events (eventos y seguimiento), payouts (Pagos a Terceros y BRE-B), plugins (WooCommerce, Shopify, VTEX…), reports (reportes), sdk (docs del SDK @pulgueta/wompi)",
      },
    },
    required: ["query"],
    additionalProperties: false,
  }),
  execute: async (ctx, { query, section }) => {
    const { results, entries } = await rag.search(ctx, {
      namespace: WOMPI_DOCS_NAMESPACE,
      query,
      limit: 5,
      ...(section !== undefined
        ? { filters: [{ name: "section" as const, value: section }] }
        : {}),
    });
    if (results.length === 0) {
      return "No se encontraron documentos en el índice. (¿Ya se ejecutó `pnpm ingest-docs` con OPENAI_API_KEY configurada?)";
    }
    return results
      .map((result) => {
        const entry = entries.find((e) => e.entryId === result.entryId);
        const metadata = entry?.metadata as
          | { title?: string; url?: string }
          | undefined;
        const title = metadata?.title ?? entry?.title ?? "Documento";
        const url = metadata?.url;
        const text = result.content.map((chunk) => chunk.text).join("\n");
        return `## Fuente: ${title}${url ? ` (${url})` : ""}${
          entry?.key ? `\n[source: ${entry.key}]` : ""
        }\n${text}`;
      })
      .join("\n\n---\n\n");
  },
});

const readWompiDoc = createTool({
  description:
    "Lee el markdown completo de un documento ya indexado (guardado en Convex storage). Usa el valor [source: ...] devuelto por searchWompiDocs cuando los fragmentos no alcancen.",
  inputSchema: jsonSchema<{ source: string }>({
    type: "object",
    properties: {
      source: {
        type: "string",
        description:
          "Clave del documento, tal como aparece en [source: ...] de searchWompiDocs",
      },
    },
    required: ["source"],
    additionalProperties: false,
  }),
  execute: async (ctx, { source }): Promise<string> => {
    // Explicit return type breaks the type cycle through internal.rag.*.
    const doc: {
      title: string;
      url?: string;
      storageId: Id<"_storage">;
    } | null = await ctx.runQuery(internal.rag.getDocBySource, { source });
    if (doc === null) {
      return `No existe un documento con source "${source}".`;
    }
    const blob = await ctx.storage.get(doc.storageId);
    if (blob === null) {
      return `El documento "${source}" no tiene archivo en storage.`;
    }
    const text = await blob.text();
    const content =
      text.length > MAX_DOC_CHARS
        ? `${text.slice(0, MAX_DOC_CHARS)}\n\n[... documento truncado, usa searchWompiDocs para fragmentos específicos ...]`
        : text;
    return `# ${doc.title}${doc.url ? ` (${doc.url})` : ""}\n\n${content}`;
  },
});

const getSdkExample = createTool({
  description:
    "Devuelve un ejemplo de código curado del SDK @pulgueta/wompi. Temas: cliente, checkout, webhooks, payouts.",
  inputSchema: jsonSchema<{ topic: string }>({
    type: "object",
    properties: {
      topic: {
        type: "string",
        description: "Uno de: cliente, checkout, webhooks, payouts",
      },
    },
    required: ["topic"],
    additionalProperties: false,
  }),
  execute: async (_ctx, { topic }) => {
    const normalized = SDK_TOPIC_ALIASES[topic.trim().toLowerCase()];
    if (normalized === undefined) {
      return `Tema desconocido: "${topic}". Temas disponibles: cliente, checkout, webhooks, payouts.`;
    }
    return SDK_EXAMPLES[normalized];
  },
});

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export const wompiAgent = new Agent(components.agent, {
  name: AGENT_NAME,
  languageModel: gateway(CHAT_MODEL),
  instructions: `Eres el "Asistente Wompi" del demo PanaBarbero: un asistente de integración de pagos Wompi (Colombia) construido con el SDK @pulgueta/wompi.

Reglas:
- SIEMPRE usa la herramienta searchWompiDocs antes de responder; complementa con getSdkExample cuando pidan código y con readWompiDoc cuando necesites el documento completo.
- Responde en español, de forma concisa y con ejemplos de código cuando aplique.
- Al final de CADA respuesta incluye una línea "Fuentes:" con los títulos de los documentos usados.
- Dominas: llaves y ambientes (sandbox vs producción), Web Checkout y autofill con customer-data, firma de integridad, webhooks transaction.updated, llaves Bre-B de sandbox, y payouts/dispersiones (Pagos a Terceros).
- Si preguntan algo no relacionado con Wompi, pagos o este demo, rechaza amablemente y redirige a temas de Wompi.`,
  tools: { searchWompiDocs, readWompiDoc, getSdkExample },
  // Without this the run ends at the first tool call and no answer is written.
  stopWhen: stepCountIs(8),
});

// ---------------------------------------------------------------------------
// Public chat API
// ---------------------------------------------------------------------------

async function authorizeThread(ctx: QueryCtx | MutationCtx, threadId: string) {
  const metadata = await getThreadMetadata(ctx, components.agent, { threadId });
  if (metadata.userId !== DEMO_USER_ID) {
    throw new Error("Hilo no autorizado");
  }
  return metadata;
}

export const createThread = mutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    await rateLimiter.limit(ctx, "createThread", { throws: true });
    return await createAgentThread(ctx, components.agent, {
      userId: DEMO_USER_ID,
      title: DEFAULT_THREAD_TITLE,
    });
  },
});

export const deleteThread = mutation({
  args: { threadId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await authorizeThread(ctx, args.threadId);
    await wompiAgent.deleteThreadAsync(ctx, { threadId: args.threadId });
    return null;
  },
});

export const listThreads = query({
  args: { threadIds: v.array(v.string()) },
  returns: v.array(
    v.object({
      threadId: v.string(),
      title: v.string(),
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const threads: Array<{
      threadId: string;
      title: string;
      createdAt: number;
    }> = [];

    for (const threadId of args.threadIds.slice(0, 20)) {
      try {
        const metadata = await getThreadMetadata(ctx, components.agent, {
          threadId,
        });
        if (metadata.userId !== DEMO_USER_ID) continue;
        threads.push({
          threadId,
          title: metadata.title ?? DEFAULT_THREAD_TITLE,
          createdAt: metadata._creationTime,
        });
      } catch {
        // Ignore missing or otherwise invalid browser-local thread ids.
      }
    }

    return threads;
  },
});

export const sendMessage = mutation({
  args: { threadId: v.string(), prompt: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const metadata = await authorizeThread(ctx, args.threadId);
    const prompt = args.prompt.trim();
    if (prompt.length === 0 || prompt.length > MAX_PROMPT_CHARS) {
      throw new Error(
        `El mensaje debe tener entre 1 y ${MAX_PROMPT_CHARS} caracteres`,
      );
    }
    await rateLimiter.limit(ctx, "sendMessagePerThread", {
      key: args.threadId,
      throws: true,
    });
    await rateLimiter.limit(ctx, "sendMessageGlobal", { throws: true });

    if (metadata.title === DEFAULT_THREAD_TITLE) {
      const title = prompt.length > 60 ? `${prompt.slice(0, 60)}…` : prompt;
      await updateThreadMetadata(ctx, components.agent, {
        threadId: args.threadId,
        patch: { title },
      });
    }

    const { messageId } = await saveMessage(ctx, components.agent, {
      threadId: args.threadId,
      userId: DEMO_USER_ID,
      prompt,
    });
    await ctx.scheduler.runAfter(0, internal.chat.streamReply, {
      threadId: args.threadId,
      promptMessageId: messageId,
    });
    return null;
  },
});

export const streamReply = internalAction({
  args: { threadId: v.string(), promptMessageId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!process.env.AI_GATEWAY_API_KEY) {
      await saveMessage(ctx, components.agent, {
        threadId: args.threadId,
        agentName: AGENT_NAME,
        message: {
          role: "assistant",
          content:
            "El chatbot aún no está configurado: falta la variable AI_GATEWAY_API_KEY en el deployment de Convex. Configúrala con `npx convex env set AI_GATEWAY_API_KEY vck_...` y vuelve a intentarlo.",
        },
      });
      return null;
    }

    try {
      await wompiAgent.streamText(
        ctx,
        { threadId: args.threadId },
        { promptMessageId: args.promptMessageId },
        { saveStreamDeltas: true },
      );
    } catch (error) {
      await saveMessage(ctx, components.agent, {
        threadId: args.threadId,
        agentName: AGENT_NAME,
        message: {
          role: "assistant",
          content: `Ocurrió un error generando la respuesta: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      });
    }
    return null;
  },
});

export const listMessages = query({
  args: {
    threadId: v.string(),
    paginationOpts: paginationOptsValidator,
    streamArgs: vStreamArgs,
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    await authorizeThread(ctx, args.threadId);
    const paginated = await listUIMessages(ctx, components.agent, {
      threadId: args.threadId,
      paginationOpts: args.paginationOpts,
    });
    const streams = await syncStreams(ctx, components.agent, {
      threadId: args.threadId,
      streamArgs: args.streamArgs,
    });
    return { ...paginated, streams };
  },
});
