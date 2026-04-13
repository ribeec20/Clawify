import { beforeEach, describe, expect, it, vi } from "vitest";

const startHeartbeatRunnerMock = vi.hoisted(() =>
  vi.fn(() => ({
    stop: vi.fn(),
    updateConfig: vi.fn(),
  })),
);
const startChannelHealthMonitorMock = vi.hoisted(() => vi.fn(() => null));
const startGatewayModelPricingRefreshMock = vi.hoisted(() => vi.fn(() => vi.fn()));
const recoverPendingDeliveriesMock = vi.hoisted(() => vi.fn(async () => undefined));
const deliverOutboundPayloadsMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../infra/heartbeat-runner.js", () => ({
  startHeartbeatRunner: startHeartbeatRunnerMock,
}));

vi.mock("./channel-health-monitor.js", () => ({
  startChannelHealthMonitor: startChannelHealthMonitorMock,
}));

vi.mock("./model-pricing-cache.js", () => ({
  startGatewayModelPricingRefresh: startGatewayModelPricingRefreshMock,
}));

vi.mock("../infra/outbound/delivery-queue.js", () => ({
  recoverPendingDeliveries: recoverPendingDeliveriesMock,
}));

vi.mock("../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: deliverOutboundPayloadsMock,
}));

const { startGatewayRuntimeServices } = await import("./server-runtime-services.js");

function createLogger() {
  return {
    child: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("startGatewayRuntimeServices feature locks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not start cron at boot when cron is startup-locked", () => {
    const cronStart = vi.fn(async () => undefined);
    const log = createLogger();

    startGatewayRuntimeServices({
      minimalTestGateway: false,
      cfgAtStart: {},
      featureLocks: {
        cronLockedOff: true,
        channelsLockedOff: false,
      },
      channelManager: {} as never,
      cron: { start: cronStart },
      logCron: { error: vi.fn() },
      log,
    });

    expect(cronStart).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith("skipping cron start (startup feature lock active)");
  });

  it("starts cron at boot when cron is not locked", () => {
    const cronStart = vi.fn(async () => undefined);

    startGatewayRuntimeServices({
      minimalTestGateway: false,
      cfgAtStart: {},
      featureLocks: {
        cronLockedOff: false,
        channelsLockedOff: false,
      },
      channelManager: {} as never,
      cron: { start: cronStart },
      logCron: { error: vi.fn() },
      log: createLogger(),
    });

    expect(cronStart).toHaveBeenCalledTimes(1);
  });
});
