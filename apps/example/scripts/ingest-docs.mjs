// Ingests the Wompi docs site + package READMEs into the "wompi-docs" RAG
// namespace by invoking the internal action rag:ingestDoc once per file.
//
// Requires OPENAI_API_KEY to be set on the Convex deployment (embeddings run
// server-side): npx convex env set OPENAI_API_KEY sk-...
//
// Usage: pnpm ingest-docs   (from apps/example)

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const repoRoot = resolve(appDir, "..", "..");

const files = [];

const docsDir = join(repoRoot, "apps", "docs", "content");
for (const entry of readdirSync(docsDir, {
  recursive: true,
  withFileTypes: true,
})) {
  if (entry.isFile() && entry.name.endsWith(".mdx")) {
    files.push(join(entry.parentPath, entry.name));
  }
}
files.push(join(repoRoot, "packages", "core", "README.md"));
files.push(join(repoRoot, "packages", "convex-component", "README.md"));

const stripFrontmatter = (raw) => {
  if (!raw.startsWith("---\n")) return { frontmatter: "", content: raw };
  const end = raw.indexOf("\n---", 4);
  if (end === -1) return { frontmatter: "", content: raw };
  return {
    frontmatter: raw.slice(4, end),
    content: raw.slice(raw.indexOf("\n", end + 1) + 1),
  };
};

const titleOf = (frontmatter, content, fallback) => {
  const fmTitle = /^title:\s*["']?(.+?)["']?\s*$/m.exec(frontmatter);
  if (fmTitle) return fmTitle[1];
  const heading = /^#\s+(.+)$/m.exec(content);
  if (heading) return heading[1];
  return fallback;
};

let ingested = 0;
for (const file of files) {
  const raw = readFileSync(file, "utf8");
  const { frontmatter, content } = stripFrontmatter(raw);
  const source = relative(repoRoot, file);
  const trimmed = content.trim();
  if (trimmed.length === 0) continue;

  const payload = {
    title: titleOf(frontmatter, trimmed, source),
    source,
    // Repository docs and READMEs are the SDK section of the corpus.
    section: "sdk",
    content: trimmed,
  };

  console.log(`Ingesting ${source} (${trimmed.length} chars)…`);
  // execFileSync avoids shell quoting issues with the JSON payload.
  execFileSync(
    "npx",
    ["convex", "run", "rag:ingestDoc", JSON.stringify(payload)],
    {
      cwd: appDir,
      stdio: "inherit",
    },
  );
  ingested += 1;
}

console.log(
  `Done: ${ingested} document(s) ingested into the "wompi-docs" namespace.`,
);
