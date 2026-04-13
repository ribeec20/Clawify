import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawifyCustomToolDefinition } from "../config/types.clawify.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { applyClawifyScopeToConfig } from "../config/clawify-scope.js";
import {
  createCustomToolFromDefinition,
  resolveCustomToolsFromConfig,
} from "../agents/tools/custom-tool-factory.js";

function makeDef(
  name: string,
  overrides?: Partial<ClawifyCustomToolDefinition>,
): ClawifyCustomToolDefinition {
  return {
    name,
    description: `Custom tool: ${name}`,
    parameters: { type: "object", properties: { input: { type: "string" } } },
    target: { url: `https://tools.example.com/${name}` },
    ...overrides,
  };
}

function makeFullConfig(params: {
  customTools?: Record<string, ClawifyCustomToolDefinition>;
  instanceDeny?: string[];
  userDeny?: string[];
  toolsPolicy?: "none" | "allowlist-extend" | "replace";
}): OpenClawConfig {
  return {
    clawify: {
      instances: {
        "test-app": {
          customTools: params.customTools,
          ...(params.instanceDeny ? { tools: { deny: params.instanceDeny } } : {}),
          userPolicy: { tools: params.toolsPolicy ?? "replace" },
          users: {
            "user-1": {
              tools: {
                ...(params.userDeny ? { deny: params.userDeny } : {}),
              },
            },
          },
        },
      },
    },
  };
}

describe("custom tools integration", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("registered custom tool appears in resolved tools", () => {
    const cfg: OpenClawConfig = {
      clawify: {
        instances: {
          "test-app": {
            customTools: {
              lookup: makeDef("lookup_customer"),
            },
          },
        },
      },
    };

    const { tools } = resolveCustomToolsFromConfig(cfg, "test-app");
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("lookup_customer");
    expect(tools[0].description).toBe("Custom tool: lookup_customer");
  });

  it("removable:false tool survives user deny through scope merging", () => {
    const cfg = makeFullConfig({
      customTools: {
        audit: makeDef("audit_log", { removable: false }),
        helper: makeDef("helper_tool", { removable: true }),
      },
      userDeny: ["audit_log", "helper_tool"],
      toolsPolicy: "replace",
    });

    const scoped = applyClawifyScopeToConfig({
      cfg,
      scope: { instanceId: "test-app", userId: "user-1" },
    });

    // audit_log is non-removable, should be filtered from deny
    // helper_tool is removable, should remain in deny
    expect(scoped.tools?.deny).toEqual(["helper_tool"]);

    // Custom tools are still present in the config for tool resolution
    const { tools, nonRemovableNames } = resolveCustomToolsFromConfig(scoped, "test-app");
    expect(tools).toHaveLength(2);
    expect(nonRemovableNames.has("audit_log")).toBe(true);
  });

  it("custom tool invocation calls the configured HTTP endpoint", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ customerId: "cust-123", name: "Jane" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    globalThis.fetch = mockFetch;

    const def = makeDef("lookup_customer", {
      target: {
        url: "https://api.myapp.com/customers/lookup",
        method: "POST",
        auth: { type: "bearer", token: "app-secret" },
        headers: { "x-request-id": "req-001" },
        timeoutMs: 10_000,
      },
    });

    const tool = createCustomToolFromDefinition(def);
    const result = await tool.execute!("call-1", { email: "jane@example.com" });

    // Verify the endpoint was called correctly
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.myapp.com/customers/lookup");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ email: "jane@example.com" });

    const headers = init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer app-secret");
    expect(headers["x-request-id"]).toBe("req-001");
    expect(headers["content-type"]).toBe("application/json");

    // Verify the result
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(JSON.parse(text)).toEqual({ customerId: "cust-123", name: "Jane" });
  });

  it("full round-trip: register, resolve, scope, invoke", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response("Action logged", { status: 200 }),
    );
    globalThis.fetch = mockFetch;

    // 1. Register tools (simulated via config)
    const cfg = makeFullConfig({
      customTools: {
        audit_log: makeDef("audit_log", {
          removable: false,
          target: {
            url: "https://compliance.myapp.com/log",
            auth: { type: "bearer", token: "compliance-key" },
          },
        }),
        optional_helper: makeDef("optional_helper", { removable: true }),
      },
      userDeny: ["audit_log", "optional_helper"],
      toolsPolicy: "replace",
    });

    // 2. Apply scope (user deny should not affect non-removable audit_log)
    const scoped = applyClawifyScopeToConfig({
      cfg,
      scope: { instanceId: "test-app", userId: "user-1" },
    });
    expect(scoped.tools?.deny).toEqual(["optional_helper"]);

    // 3. Resolve custom tools
    const { tools } = resolveCustomToolsFromConfig(scoped, "test-app");
    expect(tools).toHaveLength(2);
    const auditTool = tools.find((t) => t.name === "audit_log");
    expect(auditTool).toBeDefined();

    // 4. Invoke the tool
    const result = await auditTool!.execute!("call-1", {
      action: "user_login",
      details: "User logged in from IP 10.0.0.1",
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://compliance.myapp.com/log");
    expect((init.headers as Record<string, string>)["authorization"]).toBe(
      "Bearer compliance-key",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      action: "user_login",
      details: "User logged in from IP 10.0.0.1",
    });
    expect((result.content as Array<{ text: string }>)[0].text).toBe("Action logged");
  });

  it("multiple instances have independent custom tools", () => {
    const cfg: OpenClawConfig = {
      clawify: {
        instances: {
          "app-a": {
            customTools: { tool_a: makeDef("tool_a") },
          },
          "app-b": {
            customTools: { tool_b: makeDef("tool_b") },
          },
        },
      },
    };

    const resultA = resolveCustomToolsFromConfig(cfg, "app-a");
    const resultB = resolveCustomToolsFromConfig(cfg, "app-b");

    expect(resultA.tools.map((t) => t.name)).toEqual(["tool_a"]);
    expect(resultB.tools.map((t) => t.name)).toEqual(["tool_b"]);
  });

  it("custom tool with endpoint returning error shows descriptive message", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('{"error": "rate_limited"}', { status: 429 }),
    );
    globalThis.fetch = mockFetch;

    const def = makeDef("api_tool");
    const tool = createCustomToolFromDefinition(def);
    const result = await tool.execute!("call-1", {});

    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("HTTP 429");
    expect(text).toContain("rate_limited");
    expect(result.details).toEqual({ status: "failed" });
  });

  it("custom tool survives allowlist-extend mode deny for non-removable", () => {
    const cfg = makeFullConfig({
      customTools: {
        locked: makeDef("locked_tool", { removable: false }),
      },
      userDeny: ["locked_tool"],
      toolsPolicy: "allowlist-extend",
    });

    const scoped = applyClawifyScopeToConfig({
      cfg,
      scope: { instanceId: "test-app", userId: "user-1" },
    });

    // In allowlist-extend mode, deny additions are merged into existing deny.
    // Non-removable tools should be filtered before merging.
    const denyList = scoped.tools?.deny ?? [];
    expect(denyList).not.toContain("locked_tool");
  });
});
