import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx}"],
    env: {
      AI_PROVIDER: "mock",
      NODE_ENV: "test",
      AUTH_SECRET: "test-secret-at-least-16-chars-long",
      // Tests must never touch live services or real credentials. Empty
      // strings make env() treat them as unconfigured (the code checks truthiness).
      BEDROCK_API_KEY: "",
      TYPESAFE_API_KEY: "",
      TATUM_API_KEY: "",
      MEMWAL_PRIVATE_KEY: "",
      MEMWAL_ACCOUNT_ID: "",
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
});
