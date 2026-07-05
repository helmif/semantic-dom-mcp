import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // The extraction suite shares one fixture server and one browser.
    fileParallelism: false,
  },
});
