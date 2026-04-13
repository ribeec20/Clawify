import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const buildGatewayCronServiceMock = vi.hoisted(() => vi.fn());
const startGatewayCronWithLoggingMock = vi.hoisted(() => vi.fn());
const stopGmailWatcherMock = vi.hoisted(() => vi.fn(async () => undefined));
const startGmailWatcherWithLogsMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("./server-cron.js", () => ({
  buildGatewayCronService: buildGatewayCronServiceMock,
}));

vi.mock("./server-runtime-services.js", () => ({
  startGatewayCronWithLogging: startGatewayCronWithLoggingMock,
}));

vi.mock("../hooks/gmail-watcher.js", () => ({
  stopGmailWatcher: stopGmailWatcherMock,
}));

vi.mock("../hooks/gmail-watcher-lifecycle.js", () => ({
  startGmailWatcherWithLogs: startGmailWatcherWithLogsMock,
}));

const { createGatewayReloadHandlers } = await import("./server-reload-handlers.js");

function createState() {
  return {
    hooksConfig: null,
    hookClientIpConfig: null,
    heartbeatRunner: {
      stop: vi.fn(),
      updateConfig: vi.fn(),
    },
    cronState: {
      cron: {
        stop: vi.fn(),
      },
      storePath: "/tmp/cron.json",
      cronEnabled: true,
    },
    channelHealthMonitor: null,
  } as const;
}

describe("gateway reload handlers feature locks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildGatewayCronServiceMock.mockReturnValue({
      cron: { start: vi.fn(), stop: vi.fn() },
      storePath: "/tmp/cron-next.json",
      cronEnabled: true,
    });
  });

  it("skips cron hot-reload when cron is startup-locked", async () => {
    const state = createState();
    const setState = vi.fn();
    const logReload = { info: vi.fn(), warn: vi.fn() };
    const handlers = createGatewayReloadHandlers({
      deps: {} as never,
      broadcast: vi.fn(),
      featureLocks: {
        cronLockedOff: true,
        channelsLockedOff: false,
      },
      getState: () => state as never,
      setState: setState as never,
      startChannel: vi.fn(async () => undefined),
      stopChannel: vi.fn(async () => undefined),
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels: { info: vi.fn(), error: vi.fn() },
      logCron: { error: vi.fn() },
      logReload,
      createHealthMonitor: vi.fn(() => null),
    });

    await handlers.applyHotReload(
      {
        changedPaths: ["cron.enabled"],
        restartGateway: false,
        restartReasons: [],
        hotReasons: ["cron.enabled"],
        reloadHooks: false,
        restartGmailWatcher: false,
        restartCron: true,
        restartHeartbeat: false,
        restartHealthMonitor: false,
        restartChannels: new Set(),
        noopPaths: [],
      },
      {} as OpenClawConfig,
    );

    expect(state.cronState.cron.stop).not.toHaveBeenCalled();
    expect(buildGatewayCronServiceMock).not.toHaveBeenCalled();
    expect(startGatewayCronWithLoggingMock).not.toHaveBeenCalled();
    expect(logReload.info).toHaveBeenCalledWith(
      "skipping cron reload (startup feature lock active)",
    );
    expect(setState).toHaveBeenCalledTimes(1);
  });

  it("skips channel hot-reload when channels are startup-locked", async () => {
    const state = createState();
    const stopChannel = vi.fn(async () => undefined);
    const startChannel = vi.fn(async () => undefined);
    const logChannels = { info: vi.fn(), error: vi.fn() };
    const handlers = createGatewayReloadHandlers({
      deps: {} as never,
      broadcast: vi.fn(),
      featureLocks: {
        cronLockedOff: false,
        channelsLockedOff: true,
      },
      getState: () => state as never,
      setState: vi.fn(),
      startChannel,
      stopChannel,
      logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logChannels,
      logCron: { error: vi.fn() },
      logReload: { info: vi.fn(), warn: vi.fn() },
      createHealthMonitor: vi.fn(() => null),
    });

    await handlers.applyHotReload(
      {
        changedPaths: ["channels.telegram.enabled"],
        restartGateway: false,
        restartReasons: [],
        hotReasons: ["channels.telegram.enabled"],
        reloadHooks: false,
        restartGmailWatcher: false,
        restartCron: false,
        restartHeartbeat: false,
        restartHealthMonitor: false,
        restartChannels: new Set(["telegram"]),
        noopPaths: [],
      },
      {} as OpenClawConfig,
    );

    expect(stopChannel).not.toHaveBeenCalled();
    expect(startChannel).not.toHaveBeenCalled();
    expect(logChannels.info).toHaveBeenCalledWith(
      "skipping channel reload (startup feature lock active)",
    );
  });
});
