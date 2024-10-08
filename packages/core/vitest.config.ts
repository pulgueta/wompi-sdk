import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      clean: true,
      provider: "v8",
      cleanOnRerun: true,
      reporter: ["json", "json-summary", "text"],
    },
    globals: true,
  },
});
