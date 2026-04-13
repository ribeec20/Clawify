import { describe, expect, it } from "vitest";
import {
  filterGatewayMethodsForFeatureLocks,
  findLockedConfigViolations,
  isManagementRouteEnabled,
  resolveGatewayFeatureLocks,
} from "./feature-locks.js";

describe("gateway feature locks", () => {
  it("locks channels when startup is disabled", () => {
    const locks = resolveGatewayFeatureLocks({
      cfg: {},
      channelsStartupEnabled: false,
    });
    expect(locks.channelsLockedOff).toBe(true);
    expect(locks.cronLockedOff).toBe(false);
  });

  it("locks cron when config disables cron", () => {
    const locks = resolveGatewayFeatureLocks({
      cfg: { cron: { enabled: false } },
      channelsStartupEnabled: true,
    });
    expect(locks.cronLockedOff).toBe(true);
  });

  it("filters method catalogs by lock state", () => {
    const methods = [
      "health",
      "cron.list",
      "cron.run",
      "channels.status",
      "web.login.start",
      "node.list",
    ];
    const filtered = filterGatewayMethodsForFeatureLocks(methods, {
      cronLockedOff: true,
      channelsLockedOff: true,
    });
    expect(filtered).toEqual(["health", "node.list"]);
  });

  it("hides disabled management routes", () => {
    const locks = { cronLockedOff: true, channelsLockedOff: true };
    expect(
      isManagementRouteEnabled({
        routeId: "cron-list",
        gatewayMethod: "cron.list",
        locks,
      }),
    ).toBe(false);
    expect(
      isManagementRouteEnabled({
        routeId: "channels-status",
        gatewayMethod: "channels.status",
        locks,
      }),
    ).toBe(false);
    expect(
      isManagementRouteEnabled({
        routeId: "nodes-list",
        gatewayMethod: "node.list",
        locks,
      }),
    ).toBe(true);
  });

  it("finds locked config namespace writes", () => {
    const violations = findLockedConfigViolations({
      changedPaths: [
        "cron.enabled",
        "channels.telegram.enabled",
        "gateway.profile",
        "agents.defaults.model",
      ],
      locks: { cronLockedOff: true, channelsLockedOff: true },
    });
    expect(violations).toEqual([
      { feature: "cron", paths: ["cron.enabled"] },
      { feature: "channels", paths: ["channels.telegram.enabled", "gateway.profile"] },
    ]);
  });
});
