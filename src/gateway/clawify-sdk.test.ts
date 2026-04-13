import { describe, expect, it, vi } from "vitest";
import { clawify, createClawify } from "./clawify-sdk.js";

type FetchMockFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

function readBodyObject(input: unknown): Record<string, unknown> {
  if (typeof input !== "string") {
    throw new Error("request body should be a JSON string");
  }
  const parsed = JSON.parse(input) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("request body should parse as an object");
  }
  return parsed as Record<string, unknown>;
}

function readFetchCall(
  fetchMock: { mock: { calls: Array<[RequestInfo | URL, RequestInit?]> } },
  index: number,
): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls[index];
  if (!call) {
    throw new Error(`expected fetch call at index ${index}`);
  }
  const [url, init] = call;
  return {
    url: String(url),
    init: (init ?? {}) as RequestInit,
  };
}

describe("clawify-sdk", () => {
  it("posts scoped user tools updates to the management API", async () => {
    const fetchMock = vi.fn<FetchMockFn>(async () =>
      jsonResponse(200, {
        ok: true,
        result: {
          ok: true,
        },
      }),
    );
    const client = createClawify({
      token: "token-123",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await client.user("instance-a", "user-a").updateTools({
      alsoAllow: ["write"],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, init } = readFetchCall(fetchMock, 0);
    expect(url).toBe("http://127.0.0.1:18789/v1/management/tools/update");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer token-123");
    expect(readBodyObject(init.body)).toEqual({
      instanceId: "instance-a",
      userId: "user-a",
      alsoAllow: ["write"],
    });
  });

  it("upserts user mcp config when user config does not exist yet", async () => {
    const fetchMock = vi
      .fn<FetchMockFn>()
      .mockResolvedValueOnce(
        jsonResponse(502, {
          ok: false,
          error: {
            code: "invalid_request",
            message: 'unknown clawify user "user-a" in instance "instance-a"',
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ok: true,
          result: {
            ok: true,
            instanceId: "instance-a",
            userId: "user-a",
          },
        }),
      );
    const client = createClawify({
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await client.user("instance-a", "user-a").setMcpServer("docs", {
      url: "https://mcp.example.com/sse",
      transport: "sse",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const getCall = readFetchCall(fetchMock, 0);
    const upsertCall = readFetchCall(fetchMock, 1);
    const getUrl = getCall.url;
    expect(getUrl).toBe(
      "http://127.0.0.1:18789/v1/management/clawify/users/get?instanceId=instance-a&userId=user-a",
    );
    const upsertUrl = upsertCall.url;
    const upsertInit = upsertCall.init;
    expect(upsertUrl).toBe("http://127.0.0.1:18789/v1/management/clawify/users/upsert");
    expect(readBodyObject(upsertInit.body)).toEqual({
      instanceId: "instance-a",
      userId: "user-a",
      config: {
        mcp: {
          servers: {
            docs: {
              url: "https://mcp.example.com/sse",
              transport: "sse",
            },
          },
        },
      },
    });
  });

  it("supports clawify.instance(...).user(...).prompt(...) with scoped sessions", async () => {
    const fetchMock = vi
      .fn<FetchMockFn>()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ok: true,
          result: {
            key: "session-1",
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ok: true,
          result: {
            runId: "run-1",
            messageSeq: 7,
          },
        }),
      );

    const agent = clawify
      .instance("instance-a", {
        fetchImpl: fetchMock as unknown as typeof fetch,
      })
      .user("user-a");

    const promptResult = await agent.prompt("edit the file", {
      model: "mock/noop-model",
      timeoutMs: 3_000,
    });

    expect(promptResult).toEqual({
      key: "session-1",
      runId: "run-1",
      messageSeq: 7,
      status: undefined,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const createCall = readFetchCall(fetchMock, 0);
    const sendCall = readFetchCall(fetchMock, 1);
    const createUrl = createCall.url;
    const createInit = createCall.init;
    expect(createUrl).toBe("http://127.0.0.1:18789/v1/management/sessions/create");
    expect(readBodyObject(createInit.body)).toEqual({
      model: "mock/noop-model",
      instanceId: "instance-a",
      userId: "user-a",
    });

    const sendUrl = sendCall.url;
    const sendInit = sendCall.init;
    expect(sendUrl).toBe("http://127.0.0.1:18789/v1/management/sessions/send");
    expect(readBodyObject(sendInit.body)).toEqual({
      key: "session-1",
      message: "edit the file",
      timeoutMs: 3_000,
      instanceId: "instance-a",
      userId: "user-a",
    });
  });

  it("reads config through management config routes", async () => {
    const fetchMock = vi
      .fn<FetchMockFn>()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ok: true,
          result: {
            config: { gateway: { profile: "api-only" } },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ok: true,
          result: {
            schema: {},
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ok: true,
          result: {
            path: "gateway.profile",
            schema: {},
          },
        }),
      );
    const client = createClawify({
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await client.getConfig();
    await client.getConfigSchema();
    await client.lookupConfigSchema("gateway.profile");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(readFetchCall(fetchMock, 0).url).toBe("http://127.0.0.1:18789/v1/management/config/get");
    expect(readFetchCall(fetchMock, 1).url).toBe(
      "http://127.0.0.1:18789/v1/management/config/schema",
    );
    const lookupCall = readFetchCall(fetchMock, 2);
    const lookupUrl = lookupCall.url;
    const lookupInit = lookupCall.init;
    expect(lookupUrl).toBe("http://127.0.0.1:18789/v1/management/config/schema/lookup");
    expect(readBodyObject(lookupInit.body)).toEqual({ path: "gateway.profile" });
  });

  it("maps cron and channels helpers to management routes", async () => {
    const fetchMock = vi.fn<FetchMockFn>(async () =>
      jsonResponse(200, {
        ok: true,
        result: {
          ok: true,
        },
      }),
    );
    const client = createClawify({
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await client.listCron({ includeDisabled: true });
    await client.getCronStatus();
    await client.addCron({ name: "job-a", schedule: { every: "5m" } });
    await client.updateCron({ id: "job-a", patch: { enabled: false } });
    await client.removeCron({ id: "job-a" });
    await client.runCron({ id: "job-a" });
    await client.listCronRuns({ scope: "all" });
    await client.getChannelsStatus({ probe: true });
    await client.logoutChannel({ channel: "telegram", accountId: "default" });

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls).toEqual([
      "http://127.0.0.1:18789/v1/management/cron/list?includeDisabled=true",
      "http://127.0.0.1:18789/v1/management/cron/status",
      "http://127.0.0.1:18789/v1/management/cron/add",
      "http://127.0.0.1:18789/v1/management/cron/update",
      "http://127.0.0.1:18789/v1/management/cron/remove",
      "http://127.0.0.1:18789/v1/management/cron/run",
      "http://127.0.0.1:18789/v1/management/cron/runs?scope=all",
      "http://127.0.0.1:18789/v1/management/channels/status?probe=true",
      "http://127.0.0.1:18789/v1/management/channels/logout",
    ]);

    const addCall = readFetchCall(fetchMock, 2);
    const updateCall = readFetchCall(fetchMock, 3);
    const removeCall = readFetchCall(fetchMock, 4);
    const runCall = readFetchCall(fetchMock, 5);
    const logoutCall = readFetchCall(fetchMock, 8);
    expect(readBodyObject(addCall.init.body)).toEqual({
      name: "job-a",
      schedule: { every: "5m" },
    });
    expect(readBodyObject(updateCall.init.body)).toEqual({
      id: "job-a",
      patch: { enabled: false },
    });
    expect(readBodyObject(removeCall.init.body)).toEqual({ id: "job-a" });
    expect(readBodyObject(runCall.init.body)).toEqual({ id: "job-a" });
    expect(readBodyObject(logoutCall.init.body)).toEqual({
      channel: "telegram",
      accountId: "default",
    });
  });

  it("registers a custom tool via instance upsert", async () => {
    const fetchMock = vi
      .fn<FetchMockFn>()
      // readConfigOrEmpty → get (returns empty instance)
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ok: true,
          result: { instanceId: "app-1", config: {} },
        }),
      )
      // upsert
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ok: true,
          result: { ok: true, instanceId: "app-1" },
        }),
      );

    const instance = clawify.instance("app-1", {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await instance.registerCustomTool("lookup_customer", {
      name: "lookup_customer",
      description: "Look up a customer by email",
      parameters: { type: "object", properties: { email: { type: "string" } } },
      target: {
        url: "https://api.example.com/lookup",
        auth: { type: "bearer", token: "secret" },
      },
      removable: false,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const upsertCall = readFetchCall(fetchMock, 1);
    expect(upsertCall.url).toBe("http://127.0.0.1:18789/v1/management/clawify/instances/upsert");
    const body = readBodyObject(upsertCall.init.body);
    expect(body.instanceId).toBe("app-1");
    const config = body.config as Record<string, unknown>;
    const customTools = config.customTools as Record<string, unknown>;
    expect(customTools).toBeDefined();
    expect(customTools.lookup_customer).toEqual({
      name: "lookup_customer",
      description: "Look up a customer by email",
      parameters: { type: "object", properties: { email: { type: "string" } } },
      target: {
        url: "https://api.example.com/lookup",
        auth: { type: "bearer", token: "secret" },
      },
      removable: false,
    });
  });

  it("removes a custom tool via instance upsert", async () => {
    const fetchMock = vi
      .fn<FetchMockFn>()
      // readConfigOrEmpty → get (returns instance with one custom tool)
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ok: true,
          result: {
            instanceId: "app-1",
            config: {
              customTools: {
                tool_a: {
                  name: "tool_a",
                  description: "Tool A",
                  parameters: {},
                  target: { url: "https://a.example.com" },
                },
                tool_b: {
                  name: "tool_b",
                  description: "Tool B",
                  parameters: {},
                  target: { url: "https://b.example.com" },
                },
              },
            },
          },
        }),
      )
      // upsert
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ok: true,
          result: { ok: true, instanceId: "app-1" },
        }),
      );

    const instance = clawify.instance("app-1", {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await instance.removeCustomTool("tool_a");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const upsertCall = readFetchCall(fetchMock, 1);
    const body = readBodyObject(upsertCall.init.body);
    const config = body.config as Record<string, unknown>;
    const customTools = config.customTools as Record<string, unknown>;
    expect(customTools.tool_a).toBeUndefined();
    expect(customTools.tool_b).toBeDefined();
  });

  it("removes last custom tool and sets customTools to undefined", async () => {
    const fetchMock = vi
      .fn<FetchMockFn>()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ok: true,
          result: {
            instanceId: "app-1",
            config: {
              customTools: {
                only_tool: {
                  name: "only_tool",
                  description: "Only tool",
                  parameters: {},
                  target: { url: "https://a.example.com" },
                },
              },
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ok: true,
          result: { ok: true, instanceId: "app-1" },
        }),
      );

    const instance = clawify.instance("app-1", {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await instance.removeCustomTool("only_tool");

    const upsertCall = readFetchCall(fetchMock, 1);
    const body = readBodyObject(upsertCall.init.body);
    const config = body.config as Record<string, unknown>;
    expect(config.customTools).toBeUndefined();
  });

  it("lists custom tools from instance config", async () => {
    const fetchMock = vi.fn<FetchMockFn>().mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        result: {
          instanceId: "app-1",
          config: {
            customTools: {
              tool_x: {
                name: "tool_x",
                description: "Tool X",
                parameters: {},
                target: { url: "https://x.example.com" },
              },
            },
          },
        },
      }),
    );

    const instance = clawify.instance("app-1", {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const tools = await instance.listCustomTools();
    expect(tools).toEqual({
      tool_x: {
        name: "tool_x",
        description: "Tool X",
        parameters: {},
        target: { url: "https://x.example.com" },
      },
    });
  });

  it("listCustomTools returns empty object when no custom tools", async () => {
    const fetchMock = vi.fn<FetchMockFn>().mockResolvedValueOnce(
      jsonResponse(200, {
        ok: true,
        result: { instanceId: "app-1", config: {} },
      }),
    );

    const instance = clawify.instance("app-1", {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const tools = await instance.listCustomTools();
    expect(tools).toEqual({});
  });
});
