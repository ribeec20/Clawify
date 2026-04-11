#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const args = new Set(process.argv.slice(2));
const env = { ...process.env };

if (args.has("--full")) {
  env.OPENCLAW_E2E_MANAGEMENT_ALL_ENDPOINTS = "1";
}

if (args.has("--include-host-mutations")) {
  env.OPENCLAW_E2E_MANAGEMENT_ALL_ENDPOINTS = "1";
  env.OPENCLAW_E2E_MANAGEMENT_INCLUDE_HOST_MUTATIONS = "1";
}

const child = spawnSync(
  process.execPath,
  [
    "scripts/run-vitest.mjs",
    "run",
    "--config",
    "vitest.e2e.config.ts",
    "src/gateway/server.management-api.endpoints.e2e.test.ts",
  ],
  {
    stdio: "inherit",
    env,
  },
);

if (child.error) {
  console.error(child.error);
  process.exit(1);
}

process.exit(child.status ?? 1);
