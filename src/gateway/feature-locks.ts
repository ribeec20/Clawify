import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfig } from "../config/config.js";
import { isTruthyEnvValue } from "../infra/env.js";

export type GatewayFeatureLockState = {
  cronLockedOff: boolean;
  channelsLockedOff: boolean;
};

export type GatewayFeatureLocks = GatewayFeatureLockState & {
  disabledGatewayMethods: ReadonlySet<string>;
};

export type LockedFeatureName = "cron" | "channels";

export type LockedConfigViolation = {
  feature: LockedFeatureName;
  paths: string[];
};

const CRON_METHOD_PREFIX = "cron.";
const CHANNEL_METHOD_PREFIXES = ["channels.", "web.login."] as const;
const CHANNEL_MANAGEMENT_ROUTE_IDS = new Set(["channels-status", "channels-logout"]);
const CRON_MANAGEMENT_ROUTE_IDS = new Set([
  "cron-list",
  "cron-status",
  "cron-add",
  "cron-update",
  "cron-remove",
  "cron-run",
  "cron-runs",
]);
const CHANNEL_LOCKED_PATH_PREFIXES = ["channels", "gateway.channels", "gateway.profile"] as const;
const CRON_LOCKED_PATH_PREFIXES = ["cron"] as const;

function pathMatchesPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}.`);
}

function collectMatchingPaths(changedPaths: readonly string[], prefixes: readonly string[]): string[] {
  const matches: string[] = [];
  for (const path of changedPaths) {
    if (prefixes.some((prefix) => pathMatchesPrefix(path, prefix))) {
      matches.push(path);
    }
  }
  return matches;
}

function readPathValue(root: unknown, path: string): unknown {
  if (!root || typeof root !== "object") {
    return undefined;
  }
  const segments = path.split(".");
  let current: unknown = root;
  for (const segment of segments) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function collectChangedPrefixes(params: {
  previousConfig?: unknown;
  nextConfig?: unknown;
  changedPaths: readonly string[];
  prefixes: readonly string[];
}): string[] {
  if (params.previousConfig === undefined || params.nextConfig === undefined) {
    return collectMatchingPaths(params.changedPaths, params.prefixes);
  }
  const changed: string[] = [];
  for (const prefix of params.prefixes) {
    const previousValue = readPathValue(params.previousConfig, prefix);
    const nextValue = readPathValue(params.nextConfig, prefix);
    if (!isDeepStrictEqual(previousValue, nextValue)) {
      changed.push(prefix);
    }
  }
  return changed;
}

export function resolveGatewayFeatureLocks(params: {
  cfg: OpenClawConfig;
  channelsStartupEnabled: boolean;
}): GatewayFeatureLocks {
  const cronLockedOff =
    isTruthyEnvValue(process.env.OPENCLAW_SKIP_CRON) || params.cfg.cron?.enabled === false;
  const channelsLockedOff =
    !params.channelsStartupEnabled ||
    isTruthyEnvValue(process.env.OPENCLAW_SKIP_CHANNELS) ||
    isTruthyEnvValue(process.env.OPENCLAW_SKIP_PROVIDERS);
  const disabledGatewayMethods = new Set<string>();
  if (cronLockedOff) {
    disabledGatewayMethods.add(CRON_METHOD_PREFIX);
  }
  if (channelsLockedOff) {
    for (const prefix of CHANNEL_METHOD_PREFIXES) {
      disabledGatewayMethods.add(prefix);
    }
  }
  return {
    cronLockedOff,
    channelsLockedOff,
    disabledGatewayMethods,
  };
}

export function isGatewayMethodLocked(method: string, locks: GatewayFeatureLockState): boolean {
  if (locks.cronLockedOff && method.startsWith(CRON_METHOD_PREFIX)) {
    return true;
  }
  if (locks.channelsLockedOff) {
    for (const prefix of CHANNEL_METHOD_PREFIXES) {
      if (method.startsWith(prefix)) {
        return true;
      }
    }
  }
  return false;
}

export function filterGatewayMethodsForFeatureLocks(
  methods: readonly string[],
  locks: GatewayFeatureLockState,
): string[] {
  return methods.filter((method) => !isGatewayMethodLocked(method, locks));
}

export function isManagementRouteEnabled(params: {
  routeId: string;
  gatewayMethod?: string;
  locks: GatewayFeatureLockState;
}): boolean {
  if (
    params.locks.cronLockedOff &&
    (CRON_MANAGEMENT_ROUTE_IDS.has(params.routeId) ||
      (typeof params.gatewayMethod === "string" &&
        params.gatewayMethod.startsWith(CRON_METHOD_PREFIX)))
  ) {
    return false;
  }
  if (
    params.locks.channelsLockedOff &&
    (CHANNEL_MANAGEMENT_ROUTE_IDS.has(params.routeId) ||
      (typeof params.gatewayMethod === "string" &&
        CHANNEL_METHOD_PREFIXES.some((prefix) => params.gatewayMethod?.startsWith(prefix))))
  ) {
    return false;
  }
  return true;
}

export function findLockedConfigViolations(params: {
  changedPaths?: readonly string[];
  previousConfig?: unknown;
  nextConfig?: unknown;
  locks: GatewayFeatureLockState;
}): LockedConfigViolation[] {
  const changedPaths = params.changedPaths ?? [];
  const violations: LockedConfigViolation[] = [];
  if (params.locks.cronLockedOff) {
    const cronPaths = collectChangedPrefixes({
      previousConfig: params.previousConfig,
      nextConfig: params.nextConfig,
      changedPaths,
      prefixes: CRON_LOCKED_PATH_PREFIXES,
    });
    if (cronPaths.length > 0) {
      violations.push({ feature: "cron", paths: cronPaths });
    }
  }
  if (params.locks.channelsLockedOff) {
    const channelPaths = collectChangedPrefixes({
      previousConfig: params.previousConfig,
      nextConfig: params.nextConfig,
      changedPaths,
      prefixes: CHANNEL_LOCKED_PATH_PREFIXES,
    });
    if (channelPaths.length > 0) {
      violations.push({ feature: "channels", paths: channelPaths });
    }
  }
  return violations;
}
