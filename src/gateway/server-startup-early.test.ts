import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const registerSkillsChangeListener = vi.hoisted(() => vi.fn(() => () => {}));
const getMachineDisplayName = vi.hoisted(() => vi.fn(async () => "OpenClaw"));
const primeRemoteSkillsCache = vi.hoisted(() => vi.fn());
const refreshRemoteBinsForConnectedNodes = vi.hoisted(() => vi.fn());
const setSkillsRemoteRegistry = vi.hoisted(() => vi.fn());
const startTaskRegistryMaintenance = vi.hoisted(() => vi.fn());
const startMcpLoopbackServer = vi.hoisted(() =>
  vi.fn(async () => ({ port: 19001, close: async () => {} })),
);
const startGatewayDiscovery = vi.hoisted(() => vi.fn());
const fakeMaintenance = vi.hoisted(
  () =>
    ({
      tickInterval: {} as ReturnType<typeof setInterval>,
      healthInterval: {} as ReturnType<typeof setInterval>,
      dedupeCleanup: {} as ReturnType<typeof setInterval>,
      mediaCleanup: null,
    }) as const,
);
const startGatewayMaintenanceTimers = vi.hoisted(() =>
  vi.fn(() => ({ ...fakeMaintenance })),
);

vi.mock("../agents/skills/refresh.js", () => ({
  registerSkillsChangeListener: (handler: unknown) => registerSkillsChangeListener(handler),
}));

vi.mock("../infra/machine-name.js", () => ({
  getMachineDisplayName: () => getMachineDisplayName(),
}));

vi.mock("../infra/skills-remote.js", () => ({
  primeRemoteSkillsCache: () => primeRemoteSkillsCache(),
  refreshRemoteBinsForConnectedNodes: (cfg: unknown) => refreshRemoteBinsForConnectedNodes(cfg),
  setSkillsRemoteRegistry: (registry: unknown) => setSkillsRemoteRegistry(registry),
}));

vi.mock("../tasks/task-registry.maintenance.js", () => ({
  startTaskRegistryMaintenance: () => startTaskRegistryMaintenance(),
}));

vi.mock("./mcp-http.js", () => ({
  startMcpLoopbackServer: (port: number) => startMcpLoopbackServer(port),
}));

vi.mock("./server-discovery-runtime.js", () => ({
  startGatewayDiscovery: (params: unknown) => startGatewayDiscovery(params),
}));

vi.mock("./server-maintenance.js", () => ({
  startGatewayMaintenanceTimers: (params: unknown) => startGatewayMaintenanceTimers(params),
}));

const { startGatewayEarlyRuntime } = await import("./server-startup-early.js");

function createParams(
  overrides: Partial<Parameters<typeof startGatewayEarlyRuntime>[0]> = {},
): Parameters<typeof startGatewayEarlyRuntime>[0] {
  let skillsRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  return {
    minimalTestGateway: false,
    cfgAtStart: {} as OpenClawConfig,
    port: 18789,
    gatewayTls: { enabled: false },
    tailscaleMode: "off",
    log: { info: vi.fn(), warn: vi.fn() },
    logDiscovery: { info: vi.fn(), warn: vi.fn() },
    nodeRegistry: {} as Parameters<typeof setSkillsRemoteRegistry>[0],
    broadcast: vi.fn(),
    nodeSendToAllSubscribed: vi.fn(),
    getPresenceVersion: () => 1,
    getHealthVersion: () => 1,
    refreshGatewayHealthSnapshot: vi.fn(async () => ({}) as never),
    logHealth: { error: vi.fn() },
    dedupe: new Map(),
    chatAbortControllers: new Map(),
    chatRunState: { abortedRuns: new Map() },
    chatRunBuffers: new Map(),
    chatDeltaSentAt: new Map(),
    chatDeltaLastBroadcastLen: new Map(),
    removeChatRun: vi.fn(() => undefined),
    agentRunSeq: new Map(),
    nodeSendToSession: vi.fn(),
    skillsRefreshDelayMs: 50,
    getSkillsRefreshTimer: () => skillsRefreshTimer,
    setSkillsRefreshTimer: (timer) => {
      skillsRefreshTimer = timer;
    },
    loadConfig: () => ({} as OpenClawConfig),
    ...overrides,
  };
}

describe("startGatewayEarlyRuntime", () => {
  beforeEach(() => {
    registerSkillsChangeListener.mockReset();
    registerSkillsChangeListener.mockReturnValue(() => {});
    getMachineDisplayName.mockReset();
    getMachineDisplayName.mockResolvedValue("OpenClaw");
    primeRemoteSkillsCache.mockReset();
    refreshRemoteBinsForConnectedNodes.mockReset();
    setSkillsRemoteRegistry.mockReset();
    startTaskRegistryMaintenance.mockReset();
    startMcpLoopbackServer.mockReset();
    startMcpLoopbackServer.mockResolvedValue({
      port: 19001,
      close: async () => {},
    });
    startGatewayDiscovery.mockReset();
    startGatewayDiscovery.mockResolvedValue({ bonjourStop: null });
    startGatewayMaintenanceTimers.mockReset();
    startGatewayMaintenanceTimers.mockReturnValue({ ...fakeMaintenance });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("continues startup when discovery hangs past timeout", async () => {
    vi.useFakeTimers();
    startGatewayDiscovery.mockImplementation(async () => await new Promise(() => {}));
    const discoveryWarn = vi.fn();

    const startup = startGatewayEarlyRuntime(
      createParams({
        logDiscovery: { info: vi.fn(), warn: discoveryWarn },
      }),
    );

    await vi.advanceTimersByTimeAsync(5_001);
    const result = await startup;

    expect(result.bonjourStop).toBeNull();
    expect(discoveryWarn).toHaveBeenCalledWith(
      expect.stringContaining("gateway discovery startup skipped"),
    );
  });

  it("keeps bonjour stop hook when discovery starts promptly", async () => {
    const stop = vi.fn(async () => {});
    startGatewayDiscovery.mockResolvedValue({ bonjourStop: stop });

    const result = await startGatewayEarlyRuntime(createParams());

    expect(result.bonjourStop).toBe(stop);
  });

  it("rethrows non-timeout discovery failures", async () => {
    startGatewayDiscovery.mockRejectedValue(new Error("discovery failed"));

    await expect(startGatewayEarlyRuntime(createParams())).rejects.toThrow("discovery failed");
  });
});
