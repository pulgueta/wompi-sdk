import { v } from "convex/values";
import { gateway } from "ai";
import { RAG } from "@convex-dev/rag";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { components, internal } from "./_generated/api";

export const WOMPI_DOCS_NAMESPACE = "wompi-docs";

// The id must keep the provider prefix; "text-embedding-3-small" alone fails
// against the AI Gateway.
const EMBEDDING_MODEL =
  process.env.AI_GATEWAY_EMBEDDING_MODEL ?? "openai/text-embedding-3-small";

/** Sections used to narrow the docs search. Assigned by the ingest scripts. */
export const DOC_SECTIONS = [
  "getting-started",
  "checkout",
  "events",
  "payouts",
  "plugins",
  "reports",
  "sdk",
] as const;

export type DocSection = (typeof DOC_SECTIONS)[number];

export const rag = new RAG<{ section: string }>(components.rag, {
  textEmbeddingModel: gateway.embedding(EMBEDDING_MODEL),
  embeddingDimension: 1536,
  filterNames: ["section"],
});

/**
 * Ingest one doc into the "wompi-docs" namespace. Driven by
 * scripts/ingest-docs.mjs and scripts/ingest-wompi-docs.mjs; re-running
 * replaces entries by key, so ingestion is idempotent per source path.
 *
 * The raw markdown is also saved to Convex file storage (docs table) so the
 * agent can read a full document by source without going through chunks.
 */
export const ingestDoc = internalAction({
  args: {
    title: v.string(),
    source: v.string(),
    url: v.optional(v.string()),
    section: v.optional(v.string()),
    content: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const storageId = await ctx.storage.store(
      new Blob([args.content], { type: "text/markdown" }),
    );
    await ctx.runMutation(internal.rag.saveDocFile, {
      source: args.source,
      title: args.title,
      ...(args.url !== undefined ? { url: args.url } : {}),
      storageId,
      chars: args.content.length,
    });
    await rag.add(ctx, {
      namespace: WOMPI_DOCS_NAMESPACE,
      key: args.source,
      title: args.title,
      metadata: {
        title: args.title,
        ...(args.url !== undefined ? { url: args.url } : {}),
        ...(args.section !== undefined ? { section: args.section } : {}),
      },
      ...(args.section !== undefined
        ? { filterValues: [{ name: "section" as const, value: args.section }] }
        : {}),
      text: args.content,
    });
    return null;
  },
});

export const saveDocFile = internalMutation({
  args: {
    source: v.string(),
    title: v.string(),
    url: v.optional(v.string()),
    storageId: v.id("_storage"),
    chars: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("docs")
      .withIndex("by_source", (q) => q.eq("source", args.source))
      .unique();
    if (existing !== null) {
      await ctx.storage.delete(existing.storageId);
      await ctx.db.delete(existing._id);
    }
    await ctx.db.insert("docs", args);
    return null;
  },
});

export const getDocBySource = internalQuery({
  args: { source: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      title: v.string(),
      url: v.optional(v.string()),
      storageId: v.id("_storage"),
    }),
  ),
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("docs")
      .withIndex("by_source", (q) => q.eq("source", args.source))
      .unique();
    if (doc === null) return null;
    return {
      title: doc.title,
      ...(doc.url !== undefined ? { url: doc.url } : {}),
      storageId: doc.storageId,
    };
  },
});

export const listDocs = internalQuery({
  args: {},
  returns: v.array(
    v.object({
      source: v.string(),
      title: v.string(),
      chars: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const docs = await ctx.db.query("docs").take(200);
    return docs.map((doc) => ({
      source: doc.source,
      title: doc.title,
      chars: doc.chars,
    }));
  },
});
