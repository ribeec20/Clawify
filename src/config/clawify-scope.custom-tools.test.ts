import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "./types.openclaw.js";
import { applyClawifyScopeToConfig } from "./clawify-scope.js";

function makeConfig(params: {
  customTools?: Record<string, { name: string; removable?: boolean }>;
  userDeny?: string[];
  userAllow?: string[];
  instanceDeny?: string[];
  toolsPolicy?: "none" | "allowlist-extend" | "replace";
}): OpenClawConfig {
  const customTools: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(params.customTools ?? {})) {
    customTools[key] = {
      name: def.name,
      description: `Tool ${def.name}`,
      parameters: {},
      target: { url: `https://example.com/${def.name}` },
      ...(def.removable !== undefined ? { removable: def.removable } : {}),
    };
  }

  return {
    clawify: {
      instances: {
        "app-1": {
          ...(Object.keys(customTools).length > 0 ? { customTools: customTools as never } : {}),
          ...(params.instanceDeny ? { tools: { deny: params.instanceDeny } } : {}),
          userPolicy: {
            tools: params.toolsPolicy ?? "replace",
          },
          users: {
            "user-1": {
              tools: {
                ...(params.userDeny ? { deny: params.userDeny } : {}),
                ...(params.userAllow ? { allow: params.userAllow } : {}),
              },
            },
          },
        },
      },
    },
  };
}

describe("applyClawifyScopeToConfig with custom tools", () => {
  it("non-removable custom tool survives user-level deny (replace mode)", () => {
    const cfg = makeConfig({
      customTools: {
        audit: { name: "audit_log", removable: false },
      },
      userDeny: ["audit_log", "exec"],
      toolsPolicy: "replace",
    });

    const scoped = applyClawifyScopeToConfig({
      cfg,
      scope: { instanceId: "app-1", userId: "user-1" },
    });

    // audit_log should be filtered from deny, exec should remain
    expect(scoped.tools?.deny).toEqual(["exec"]);
  });

  it("non-removable custom tool survives user-level deny (allowlist-extend mode)", () => {
    const cfg = makeConfig({
      customTools: {
        audit: { name: "audit_log", removable: false },
      },
      userDeny: ["audit_log", "write"],
      toolsPolicy: "allowlist-extend",
    });

    const scoped = applyClawifyScopeToConfig({
      cfg,
      scope: { instanceId: "app-1", userId: "user-1" },
    });

    // audit_log should be filtered from deny, write should remain
    expect(scoped.tools?.deny).toEqual(["write"]);
  });

  it("removable custom tool is denied by user-level deny", () => {
    const cfg = makeConfig({
      customTools: {
        helper: { name: "helper_tool", removable: true },
      },
      userDeny: ["helper_tool"],
      toolsPolicy: "replace",
    });

    const scoped = applyClawifyScopeToConfig({
      cfg,
      scope: { instanceId: "app-1", userId: "user-1" },
    });

    expect(scoped.tools?.deny).toEqual(["helper_tool"]);
  });

  it("default removable (undefined) custom tool is denied by user-level deny", () => {
    const cfg = makeConfig({
      customTools: {
        helper: { name: "helper_tool" }, // removable defaults to true
      },
      userDeny: ["helper_tool"],
      toolsPolicy: "replace",
    });

    const scoped = applyClawifyScopeToConfig({
      cfg,
      scope: { instanceId: "app-1", userId: "user-1" },
    });

    expect(scoped.tools?.deny).toEqual(["helper_tool"]);
  });

  it("instance-level deny still affects non-removable tools", () => {
    const cfg = makeConfig({
      customTools: {
        audit: { name: "audit_log", removable: false },
      },
      instanceDeny: ["audit_log"],
    });

    const scoped = applyClawifyScopeToConfig({
      cfg,
      scope: { instanceId: "app-1" },
    });

    // Instance-level deny is applied directly (not subject to non-removable filtering)
    expect(scoped.tools?.deny).toEqual(["audit_log"]);
  });

  it("no custom tools in config has no effect on scope merging", () => {
    const cfg = makeConfig({
      userDeny: ["exec"],
      toolsPolicy: "replace",
    });

    const scoped = applyClawifyScopeToConfig({
      cfg,
      scope: { instanceId: "app-1", userId: "user-1" },
    });

    expect(scoped.tools?.deny).toEqual(["exec"]);
  });

  it("all denied tools are non-removable results in empty deny", () => {
    const cfg = makeConfig({
      customTools: {
        audit: { name: "audit_log", removable: false },
        safety: { name: "safety_check", removable: false },
      },
      userDeny: ["audit_log", "safety_check"],
      toolsPolicy: "replace",
    });

    const scoped = applyClawifyScopeToConfig({
      cfg,
      scope: { instanceId: "app-1", userId: "user-1" },
    });

    // All deny entries filtered, resulting in empty array
    expect(scoped.tools?.deny ?? []).toEqual([]);
  });

  it("tools policy 'none' ignores user tools entirely", () => {
    const cfg = makeConfig({
      customTools: {
        audit: { name: "audit_log", removable: false },
      },
      userDeny: ["audit_log"],
      toolsPolicy: "none",
    });

    const scoped = applyClawifyScopeToConfig({
      cfg,
      scope: { instanceId: "app-1", userId: "user-1" },
    });

    // User tools are completely ignored in "none" mode
    expect(scoped.tools?.deny).toBeUndefined();
  });
});
