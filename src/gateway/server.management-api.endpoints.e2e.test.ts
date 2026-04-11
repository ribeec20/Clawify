import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getFreePort, installGatewayTestHooks, startGatewayServer } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const RUN_MANAGEMENT_ROUTE_SWEEP = process.env.OPENCLAW_E2E_MANAGEMENT_ALL_ENDPOINTS === "1";
const INCLUDE_HOST_MUTATIONS =
  process.env.OPENCLAW_E2E_MANAGEMENT_INCLUDE_HOST_MUTATIONS === "1";

const HOST_MUTATION_ROUTE_IDS = new Set([
  "host-install",
  "host-start",
  "host-stop",
  "host-restart",
  "host-uninstall",
]);

type ManagementRoute = {
  id: string;
  method: "GET" | "POST";
  path: string;
  gatewayMethod?: string;
};

type ManagementRootResponse = {
  ok?: boolean;
  result?: {
    prefix?: string;
    routes?: ManagementRoute[];
  };
};

type JsonResponse = {
  status: number;
  text: string;
  json: unknown;
  headers: Headers;
};

let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
let baseUrl = "";

async function requestJson(
  path: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<JsonResponse> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: init?.method,
    headers: init?.headers,
    body: init?.body,
  });
  const text = await response.text();
  let json: unknown = null;
  if (text.trim().length > 0) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return {
    status: response.status,
    text,
    json,
    headers: response.headers,
  };
}

function buildSweepProbeBody(route: ManagementRoute): Record<string, unknown> {
  if (route.id === "host-install") {
    // Keep host install probes from touching host service state unless explicitly desired.
    return { runtime: "__invalid_runtime__" };
  }
  return { __endpointSweepProbe: route.id };
}

describe("gateway management api endpoint e2e", () => {
  beforeAll(async () => {
    const port = await getFreePort();
    server = await startGatewayServer(port, {
      auth: { mode: "none" },
      controlUiEnabled: false,
      managementApiEnabled: true,
    });
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await server?.close();
  });

  it("serves management inventory, events stream, and sessions send flow", async () => {
    const health = await requestJson("/health");
    expect(health.status).toBe(200);
    expect(health.json).toEqual(expect.objectContaining({ ok: true }));

    const managementRoot = await requestJson("/v1/management");
    expect(managementRoot.status).toBe(200);
    const rootPayload = managementRoot.json as ManagementRootResponse;
    expect(rootPayload.ok).toBe(true);
    expect(rootPayload.result?.prefix).toBe("/v1/management");
    expect(Array.isArray(rootPayload.result?.routes)).toBe(true);
    expect((rootPayload.result?.routes ?? []).length).toBeGreaterThan(0);

    const eventsResponse = await fetch(`${baseUrl}/v1/management/events`);
    expect(eventsResponse.status).toBe(200);
    expect(eventsResponse.headers.get("content-type") ?? "").toContain("text/event-stream");
    await eventsResponse.body?.cancel();

    const createSession = await requestJson("/v1/management/sessions/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock/noop-model" }),
    });
    expect(createSession.status).toBe(200);
    const createPayload = createSession.json as {
      ok?: boolean;
      result?: { key?: string };
      route?: { routeId?: string };
    };
    expect(createPayload.ok).toBe(true);
    expect(createPayload.route?.routeId).toBe("sessions-create");
    expect(typeof createPayload.result?.key).toBe("string");

    const sendSession = await requestJson("/v1/management/sessions/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        key: createPayload.result?.key,
        message: "endpoint smoke test",
      }),
    });
    expect(sendSession.status).toBe(200);
    const sendPayload = sendSession.json as {
      ok?: boolean;
      result?: { runId?: string; messageSeq?: number };
      route?: { routeId?: string };
    };
    expect(sendPayload.ok).toBe(true);
    expect(sendPayload.route?.routeId).toBe("sessions-send");
    expect(typeof sendPayload.result?.runId).toBe("string");
    expect(typeof sendPayload.result?.messageSeq).toBe("number");
  });

  it.skipIf(!RUN_MANAGEMENT_ROUTE_SWEEP)(
    "sweeps every advertised management route against the live gateway http surface",
    { timeout: 120_000 },
    async () => {
      const managementRoot = await requestJson("/v1/management");
      expect(managementRoot.status).toBe(200);
      const rootPayload = managementRoot.json as ManagementRootResponse;
      const routes = (rootPayload.result?.routes ?? []).slice().sort((a, b) => {
        const byPath = a.path.localeCompare(b.path);
        if (byPath !== 0) {
          return byPath;
        }
        return a.method.localeCompare(b.method);
      });
      expect(routes.length).toBeGreaterThan(0);

      const exercisedRouteIds: string[] = [];
      const skippedRouteIds: string[] = [];

      for (const route of routes) {
        if (!INCLUDE_HOST_MUTATIONS && HOST_MUTATION_ROUTE_IDS.has(route.id)) {
          skippedRouteIds.push(route.id);
          continue;
        }

        const requestInit =
          route.method === "POST"
            ? {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(buildSweepProbeBody(route)),
              }
            : {
                method: "GET",
              };

        const response = await requestJson(route.path, requestInit);
        expect(
          response.status,
          `${route.method} ${route.path} returned missing endpoint status ${response.status}`,
        ).not.toBe(404);
        expect(
          response.status,
          `${route.method} ${route.path} returned method-not-allowed with matched route`,
        ).not.toBe(405);

        const payloadRecord =
          response.json && typeof response.json === "object" && !Array.isArray(response.json)
            ? (response.json as Record<string, unknown>)
            : null;
        expect(payloadRecord, `${route.method} ${route.path} should return json`).not.toBeNull();

        const routeInfo =
          payloadRecord &&
          payloadRecord.route &&
          typeof payloadRecord.route === "object" &&
          !Array.isArray(payloadRecord.route)
            ? (payloadRecord.route as Record<string, unknown>)
            : null;
        if (routeInfo?.routeId !== undefined) {
          expect(routeInfo.routeId).toBe(route.id);
        }

        exercisedRouteIds.push(route.id);
      }

      expect(exercisedRouteIds.length).toBeGreaterThan(0);
      if (!INCLUDE_HOST_MUTATIONS) {
        expect(skippedRouteIds.length).toBeGreaterThan(0);
      }
    },
  );
});
