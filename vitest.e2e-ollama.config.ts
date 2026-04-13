import os from "node:os";
import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config.ts";

const base = baseConfig as unknown as Record<string, unknown>;

const baseTestWithProjects =
  (baseConfig as { test?: { exclude?: string[]; projects?: string[]; setupFiles?: string[] } })
    .test ?? {};
const { projects: _projects, ...baseTest } = baseTestWithProjects as {
  exclude?: string[];
  projects?: string[];
  setupFiles?: string[];
};

export default defineConfig({
  ...base,
  test: {
    ...baseTest,
    include: ["test/sdk-file-tools-ollama.e2e.test.ts"],
    exclude: [],
    testTimeout: 180_000,
    hookTimeout: 120_000,
    maxWorkers: 1,
    minWorkers: 1,
    setupFiles: [...new Set([...(baseTest.setupFiles ?? []), "test/setup-openclaw-runtime.ts"])],
  },
});
