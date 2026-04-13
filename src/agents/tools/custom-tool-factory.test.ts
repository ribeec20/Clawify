import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawifyCustomToolDefinition } from "../../config/types.clawify.js";
import { createCustomToolFromDefinition, resolveCustomToolsFromConfig } from "./custom-tool-factory.js";

function makeDef(overrides?: Partial<ClawifyCustomToolDefinition>): ClawifyCustomToolDefinition {
  return {
    name: "test_tool",
    description: "A test tool",
    parameters: { type: "object", properties: { input: { type: "string" } } },
    target: { url: "https://api.example.com/tool" },
    ...overrides,
  };
}

describe("createCustomToolFromDefinition", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("creates a tool with the correct name, description, and parameters", () => {
    const def = makeDef();
    const tool = createCustomToolFromDefinition(def);

    expect(tool.name).toBe("test_tool");
    expect(tool.description).toBe("A test tool");
    expect(tool.parameters).toBeDefined();
  });

  it("calls the configured endpoint on execute", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response("ok result", { status: 200 }),
    );
    globalThis.fetch = mockFetch;

    const def = makeDef();
    const tool = createCustomToolFromDefinition(def);
    const result = await tool.execute!("call-1", { input: "hello" });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.com/tool");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ input: "hello" });
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(result.content).toEqual([{ type: "text", text: "ok result" }]);
  });

  it("uses configured HTTP method", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("done", { status: 200 }));
    globalThis.fetch = mockFetch;

    const def = makeDef({ target: { url: "https://api.example.com/tool", method: "PUT" } });
    const tool = createCustomToolFromDefinition(def);
    await tool.execute!("call-1", {});

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("PUT");
  });

  it("sends bearer auth header", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    globalThis.fetch = mockFetch;

    const def = makeDef({
      target: {
        url: "https://api.example.com/tool",
        auth: { type: "bearer", token: "my-secret-token" },
      },
    });
    const tool = createCustomToolFromDefinition(def);
    await tool.execute!("call-1", {});

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["authorization"]).toBe(
      "Bearer my-secret-token",
    );
  });

  it("sends custom header auth", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    globalThis.fetch = mockFetch;

    const def = makeDef({
      target: {
        url: "https://api.example.com/tool",
        auth: { type: "header", name: "x-api-key", value: "key-123" },
      },
    });
    const tool = createCustomToolFromDefinition(def);
    await tool.execute!("call-1", {});

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("key-123");
  });

  it("merges custom headers from target", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    globalThis.fetch = mockFetch;

    const def = makeDef({
      target: {
        url: "https://api.example.com/tool",
        headers: { "x-custom": "value-1" },
      },
    });
    const tool = createCustomToolFromDefinition(def);
    await tool.execute!("call-1", {});

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["x-custom"]).toBe("value-1");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("returns error result on HTTP 4xx", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response("not found", { status: 404 }));
    globalThis.fetch = mockFetch;

    const def = makeDef();
    const tool = createCustomToolFromDefinition(def);
    const result = await tool.execute!("call-1", {});

    expect(result.content).toEqual([
      { type: "text", text: 'custom tool "test_tool" returned HTTP 404: not found' },
    ]);
    expect(result.details).toEqual({ status: "failed" });
  });

  it("returns error result on HTTP 5xx", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response("internal server error", { status: 500 }));
    globalThis.fetch = mockFetch;

    const def = makeDef();
    const tool = createCustomToolFromDefinition(def);
    const result = await tool.execute!("call-1", {});

    expect(result.content).toEqual([
      {
        type: "text",
        text: 'custom tool "test_tool" returned HTTP 500: internal server error',
      },
    ]);
    expect(result.details).toEqual({ status: "failed" });
  });

  it("truncates long error response bodies", async () => {
    const longBody = "x".repeat(600);
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response(longBody, { status: 500 }));
    globalThis.fetch = mockFetch;

    const def = makeDef();
    const tool = createCustomToolFromDefinition(def);
    const result = await tool.execute!("call-1", {});

    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("...");
    expect(text.length).toBeLessThan(600);
  });

  it("handles network errors gracefully", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    globalThis.fetch = mockFetch;

    const def = makeDef();
    const tool = createCustomToolFromDefinition(def);
    const result = await tool.execute!("call-1", {});

    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("request failed");
    expect(text).toContain("ECONNREFUSED");
    expect(result.details).toEqual({ status: "failed" });
  });

  it("handles timeout errors", async () => {
    const timeoutError = new DOMException("The operation was aborted", "TimeoutError");
    const mockFetch = vi.fn().mockRejectedValue(timeoutError);
    globalThis.fetch = mockFetch;

    const def = makeDef({ target: { url: "https://api.example.com/tool", timeoutMs: 5000 } });
    const tool = createCustomToolFromDefinition(def);
    const result = await tool.execute!("call-1", {});

    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("timed out");
    expect(text).toContain("5000ms");
    expect(result.details).toEqual({ status: "failed" });
  });

  it("handles empty response body", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    globalThis.fetch = mockFetch;

    const def = makeDef();
    const tool = createCustomToolFromDefinition(def);
    const result = await tool.execute!("call-1", {});

    expect(result.content).toEqual([{ type: "text", text: "(empty response)" }]);
  });
});

describe("resolveCustomToolsFromConfig", () => {
  it("returns empty result when no instanceId", () => {
    const result = resolveCustomToolsFromConfig({}, undefined);
    expect(result.tools).toEqual([]);
    expect(result.nonRemovableNames.size).toBe(0);
  });

  it("returns empty result when instance has no custom tools", () => {
    const cfg = {
      clawify: {
        instances: {
          "app-1": {},
        },
      },
    };
    const result = resolveCustomToolsFromConfig(cfg, "app-1");
    expect(result.tools).toEqual([]);
    expect(result.nonRemovableNames.size).toBe(0);
  });

  it("resolves custom tools from instance config", () => {
    const cfg = {
      clawify: {
        instances: {
          "app-1": {
            customTools: {
              tool_a: makeDef({ name: "tool_a" }),
              tool_b: makeDef({ name: "tool_b", removable: false }),
            },
          },
        },
      },
    };
    const result = resolveCustomToolsFromConfig(cfg, "app-1");
    expect(result.tools).toHaveLength(2);
    expect(result.tools.map((t) => t.name).sort()).toEqual(["tool_a", "tool_b"]);
  });

  it("collects non-removable tool names", () => {
    const cfg = {
      clawify: {
        instances: {
          "app-1": {
            customTools: {
              removable_tool: makeDef({ name: "removable_tool", removable: true }),
              locked_tool: makeDef({ name: "locked_tool", removable: false }),
              default_tool: makeDef({ name: "default_tool" }),
            },
          },
        },
      },
    };
    const result = resolveCustomToolsFromConfig(cfg, "app-1");
    expect(result.nonRemovableNames.has("locked_tool")).toBe(true);
    expect(result.nonRemovableNames.has("removable_tool")).toBe(false);
    expect(result.nonRemovableNames.has("default_tool")).toBe(false);
  });

  it("skips invalid definitions", () => {
    const cfg = {
      clawify: {
        instances: {
          "app-1": {
            customTools: {
              valid: makeDef({ name: "valid" }),
              invalid_no_url: {
                name: "bad",
                description: "bad",
                parameters: {},
                target: {},
              } as unknown as ClawifyCustomToolDefinition,
            },
          },
        },
      },
    };
    const result = resolveCustomToolsFromConfig(cfg, "app-1");
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe("valid");
  });

  it("returns empty result for unknown instance id", () => {
    const cfg = {
      clawify: {
        instances: {
          "app-1": {
            customTools: {
              tool_a: makeDef({ name: "tool_a" }),
            },
          },
        },
      },
    };
    const result = resolveCustomToolsFromConfig(cfg, "unknown-instance");
    expect(result.tools).toEqual([]);
  });
});
