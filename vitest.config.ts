import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Live smoke tests (*.live.test.ts) hit the real testnet and are opt-in via
    // HB_LIVE=1 — they are excluded from `pnpm test` / CI so a clone with no
    // network and no credentials still goes green.
    include: ["test/**/*.test.ts"],
    exclude: process.env.HB_LIVE === "1" ? [] : ["test/**/*.live.test.ts", "node_modules/**"],
  },
});
