import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src"],
  clean: true,
  splitting: true,
  treeshake: true,
  dts: true,
  format: ["cjs", "esm"],
  minify: true,
  outDir: "dist",
});
