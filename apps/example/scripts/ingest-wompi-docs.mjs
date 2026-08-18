// Ingests the docs.wompi.co (Colombia) pages into the "wompi-docs" RAG
// namespace + Convex file storage by invoking rag:ingestDoc once per page.
//
// Pages are fetched as curated markdown with the local `curl.md <url>` helper.
// Fetched markdown is cached in /tmp/wompi-docs-cache so re-runs (and parallel
// pre-fetchers) don't hit the network again.
//
// Requires AI_GATEWAY_API_KEY on the Convex deployment (embeddings run
// server-side): npx convex env set AI_GATEWAY_API_KEY vck_...
//
// Usage (from apps/example):
//   node scripts/ingest-wompi-docs.mjs             # everything
//   node scripts/ingest-wompi-docs.mjs --fetch-only <slug…>  # only warm cache
//   node scripts/ingest-wompi-docs.mjs <slug…>     # subset

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const cacheDir = "/tmp/wompi-docs-cache";
mkdirSync(cacheDir, { recursive: true });

const BASE = "https://docs.wompi.co/docs/colombia";

// (title, slug) — sidebar of docs.wompi.co, Colombia.
export const WOMPI_DOCS = [
  ["Inicio rápido", "inicio-rapido"],
  ["Conoce nuestros planes", "conoce-nuestros-planes"],
  ["Ambientes y llaves", "ambientes-y-llaves"],
  ["Widget & Checkout Web", "widget-checkout-web"],
  ["Datos de prueba en Sandbox", "datos-de-prueba-en-sandbox"],
  ["Eventos", "eventos"],
  ["Seguimiento de transacciones", "seguimiento-de-transacciones"],
  ["Reintento de pagos", "reintento-de-pago"],
  ["Roles", "roles"],
  ["Usuarios", "usuarios"],
  ["Reporte único", "reporte-unico"],
  ["Reporte recurrente", "reporte-recurrente"],
  ["WooCommerce (Wordpress)", "woocommerce-wordpress-plugin"],
  ["Shopify", "wompi-shopify-plugin"],
  ["Jumpseller", "jumpseller-plugin"],
  ["Magento", "magento-plugin"],
  ["PrestaShop", "prestashop-plugin"],
  ["VTEX", "wompi-vtex"],
  ["¿Qué es Pagos a terceros?", "que-es-pagos-a-terceros"],
  ["Pagos a terceros: Activación", "activacion-pagos-a-terceros"],
  [
    "Pagos a terceros: Configuración inicial",
    "configuracion-inicial-pagos-a-terceros",
  ],
  ["Pagos a terceros: Consulta de saldo", "consulta-saldos-pagos-a-terceros"],
  ["Pagos a terceros: Crear pago manual", "pago-manual-pagos-a-terceros"],
  [
    "Pagos a terceros: Crear pago mediante archivo",
    "pago-archivo-pagos-a-terceros",
  ],
  [
    "Pagos a terceros: Cuentas bancarias para dispersión",
    "cuentas-pagos-a-terceros",
  ],
  [
    "Pagos a terceros: Historial transacciones",
    "historial-trx-monetarias-pagos-a-terceros",
  ],
  ["Pagos a terceros: Límites transacciones", "limites-trx-pagos-a-terceros"],
  ["Pagos a terceros: Pruebas en Sandbox", "pruebas-sandbox-pagos-a-terceros"],
  ["Pagos a terceros: Reportes transacciones", "reportes-trx-pagos-a-terceros"],
  ["Pagos a terceros: Roles", "roles-pagos-a-terceros"],
  ["Pagos a terceros: Usuarios", "usuarios-pagos-a-terceros"],
  ["API Pagos a terceros: Usa nuestra API", "introduccion-pagos-a-terceros"],
  [
    "API Pagos a terceros: Llaves de autenticación",
    "ambientes-y-llaves-pagos-a-terceros",
  ],
  ["API Pagos a terceros: Crea tu primer lote", "crea-tu-primer-lote"],
  ["API Pagos a terceros: Ambiente sandbox", "sandbox-pagos-a-terceros"],
  ["API Pagos a terceros: Consultas y operaciones", "consultas-y-operaciones"],
  ["API Pagos a terceros: Eventos", "eventos-pagos-a-terceros"],
  ["API Pagos a terceros: Referencia del API", "referencia-pagos-a-terceros"],
  ["API Pagos a terceros: Errores", "errores-pagos-a-terceros"],
  ["API: Guía integración BRE-B", "guia-integracion-breb"],
  ["API: Previsualizar BRE-B", "previsualizar-breb"],
  ["API: Crear dispersión BRE-B", "crear-dispersion-breb"],
  ["API: Eventos BRE-B", "eventos-breb"],
  ["API: Errores BRE-B", "errores-breb"],
  ["API: Sandbox BRE-B", "sandbox-breb"],
  ["Tokens de aceptación", "tokens-de-aceptacion"],
  ["Transacciones", "transacciones"],
  ["Métodos de pago", "metodos-de-pago"],
  ["Fuentes de pago & Tokenización", "fuentes-de-pago"],
  ["Transacciones automáticas con el protocolo 3RI", "fuentes-de-pago-3ds"],
  [
    "Transacciones con 3D Secure (Sandbox) v2",
    "transacciones-con-3d-secure-v2",
  ],
  [
    "Fuentes de Pago Seguras con 3D Secure (Sandbox)",
    "fuentes-de-pago-3ds-sandbox",
  ],
  ["Integración de 3D Secure externo", "integracion-3ds-externo"],
  ["Errores", "errores"],
  ["Impuestos", "impuestos"],
  ["Referencia del API", "referencia"],
  ["Links de pago", "links-de-pago"],
  ["Cifrado de campos de referencia PSE (JWE)", "cifrado-jwe-pse"],
  ["WompiJs", "latest-version"],
  ["WompiJs (deprecada)", "js"],
];

// Sections mirror DOC_SECTIONS in convex/rag.ts and feed the `section` filter
// of the searchWompiDocs tool.

// "API Pagos a terceros: …" pages whose slug has no payouts marker.
const PAYOUT_SLUGS = new Set([
  "crea-tu-primer-lote",
  "consultas-y-operaciones",
]);
const PLUGIN_SLUGS = new Set([
  "woocommerce-wordpress-plugin",
  "wompi-shopify-plugin",
  "jumpseller-plugin",
  "magento-plugin",
  "prestashop-plugin",
  "wompi-vtex",
]);
const EVENT_SLUGS = new Set([
  "eventos",
  "seguimiento-de-transacciones",
  "reintento-de-pago",
]);
const CHECKOUT_SLUGS = new Set([
  "widget-checkout-web",
  "datos-de-prueba-en-sandbox",
  "ambientes-y-llaves",
]);

export const sectionFor = (slug) => {
  if (
    slug.includes("pagos-a-terceros") ||
    slug.includes("breb") ||
    PAYOUT_SLUGS.has(slug)
  ) {
    return "payouts";
  }
  if (PLUGIN_SLUGS.has(slug)) return "plugins";
  if (slug.startsWith("reporte-")) return "reports";
  if (EVENT_SLUGS.has(slug)) return "events";
  if (CHECKOUT_SLUGS.has(slug)) return "checkout";
  return "getting-started";
};

const fetchMarkdown = (slug) => {
  const cached = join(cacheDir, `${slug}.md`);
  if (existsSync(cached)) {
    const content = readFileSync(cached, "utf8").trim();
    if (content.length > 0) return content;
  }
  const url = `${BASE}/${slug}/`;
  console.log(`Fetching ${url}…`);
  const content = execFileSync("curl.md", [url], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
  if (content.length === 0 || content.includes("FETCH_FAILED")) {
    throw new Error(`curl.md failed for ${url}`);
  }
  writeFileSync(cached, content);
  return content;
};

const args = process.argv.slice(2);
const fetchOnly = args[0] === "--fetch-only";
const slugFilter = new Set(fetchOnly ? args.slice(1) : args);
const selected = WOMPI_DOCS.filter(
  ([, slug]) => slugFilter.size === 0 || slugFilter.has(slug),
);

let done = 0;
const failed = [];
for (const [title, slug] of selected) {
  try {
    const content = fetchMarkdown(slug);
    if (!fetchOnly) {
      const payload = {
        title,
        source: `wompi-docs/${slug}`,
        url: `${BASE}/${slug}/`,
        section: sectionFor(slug),
        content,
      };
      console.log(`Ingesting wompi-docs/${slug} (${content.length} chars)…`);
      // execFileSync avoids shell quoting issues with the JSON payload.
      execFileSync(
        "npx",
        ["convex", "run", "rag:ingestDoc", JSON.stringify(payload)],
        { cwd: appDir, stdio: "inherit" },
      );
    }
    done += 1;
  } catch (error) {
    failed.push(slug);
    console.error(`FAILED ${slug}: ${error.message}`);
  }
}

console.log(
  `${fetchOnly ? "Fetched" : "Ingested"} ${done}/${selected.length} document(s).`,
);
if (failed.length > 0) {
  console.error(`Failed slugs: ${failed.join(" ")}`);
  process.exitCode = 1;
}
