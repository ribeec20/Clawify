import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createConfigHandlerHarness,
  createConfigWriteSnapshot,
  flushConfigHandlerMicrotasks,
} from "./config.test-helpers.js";

const readConfigFileSnapshotForWriteMock = vi.fn();
const writeConfigFileMock = vi.fn();
const validateConfigObjectWithPluginsMock = vi.fn();
const prepareSecretsRuntimeSnapshotMock = vi.fn();
const scheduleGatewaySigusr1RestartMock = vi.fn(() => ({
  scheduled: true,
  delayMs: 1_000,
  coalesced: false,
}));

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    createConfigIO: () => ({ configPath: "/tmp/openclaw.json" }),
    readConfigFileSnapshotForWrite: readConfigFileSnapshotForWriteMock,
    validateConfigObjectWithPlugins: validateConfigObjectWithPluginsMock,
    writeConfigFile: writeConfigFileMock,
  };
});

vi.mock("../../config/runtime-schema.js", () => ({
  loadGatewayRuntimeConfigSchema: () => ({ uiHints: undefined }),
}));

vi.mock("../../secrets/runtime.js", () => ({
  prepareSecretsRuntimeSnapshot: prepareSecretsRuntimeSnapshotMock,
}));

vi.mock("../../infra/restart.js", () => ({
  scheduleGatewaySigusr1Restart: scheduleGatewaySigusr1RestartMock,
}));

const { configHandlers } = await import("./config.js");

afterEach(() => {
  vi.clearAllMocks();
});

beforeEach(() => {
  validateConfigObjectWithPluginsMock.mockImplementation((config: OpenClawConfig) => ({
    ok: true,
    config,
  }));
  prepareSecretsRuntimeSnapshotMock.mockResolvedValue(undefined);
});

describe("config shared auth disconnects", () => {
  it("does not disconnect shared-auth clients for config.set auth writes without restart", async () => {
    const prevConfig: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "token",
          token: "old-token",
        },
      },
    };
    const nextConfig: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "token",
          token: "new-token",
        },
      },
    };
    readConfigFileSnapshotForWriteMock.mockResolvedValue(createConfigWriteSnapshot(prevConfig));

    const { options, disconnectClientsUsingSharedGatewayAuth } = createConfigHandlerHarness({
      method: "config.set",
      params: {
        raw: JSON.stringify(nextConfig, null, 2),
        baseHash: "base-hash",
      },
    });

    await configHandlers["config.set"](options);
    await flushConfigHandlerMicrotasks();

    expect(writeConfigFileMock).toHaveBeenCalledWith(nextConfig, {});
    expect(disconnectClientsUsingSharedGatewayAuth).not.toHaveBeenCalled();
    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
  });

  it("lets the config reloader own hybrid-mode auth restarts", async () => {
    const prevConfig: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "token",
          token: "old-token",
        },
      },
    };
    readConfigFileSnapshotForWriteMock.mockResolvedValue(createConfigWriteSnapshot(prevConfig));

    const { options, disconnectClientsUsingSharedGatewayAuth } = createConfigHandlerHarness({
      method: "config.patch",
      params: {
        baseHash: "base-hash",
        raw: JSON.stringify({ gateway: { auth: { token: "new-token" } } }),
        restartDelayMs: 1_000,
      },
    });

    await configHandlers["config.patch"](options);
    await flushConfigHandlerMicrotasks();

    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
    expect(disconnectClientsUsingSharedGatewayAuth).toHaveBeenCalledTimes(1);
  });

  it("does not disconnect shared-auth clients when config.patch changes only inactive password auth", async () => {
    const prevConfig: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "token",
          token: "old-token",
        },
      },
    };
    readConfigFileSnapshotForWriteMock.mockResolvedValue(createConfigWriteSnapshot(prevConfig));

    const { options, disconnectClientsUsingSharedGatewayAuth } = createConfigHandlerHarness({
      method: "config.patch",
      params: {
        baseHash: "base-hash",
        raw: JSON.stringify({ gateway: { auth: { password: "new-password" } } }),
        restartDelayMs: 1_000,
      },
    });

    await configHandlers["config.patch"](options);
    await flushConfigHandlerMicrotasks();

    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
    expect(disconnectClientsUsingSharedGatewayAuth).not.toHaveBeenCalled();
  });

  it("still schedules a direct restart for hot mode when the reloader cannot apply the change", async () => {
    const prevConfig: OpenClawConfig = {
      gateway: {
        reload: {
          mode: "hot",
        },
      },
    };
    readConfigFileSnapshotForWriteMock.mockResolvedValue(createConfigWriteSnapshot(prevConfig));

    const { options } = createConfigHandlerHarness({
      method: "config.patch",
      params: {
        baseHash: "base-hash",
        raw: JSON.stringify({ gateway: { port: 19001 } }),
        restartDelayMs: 1_000,
      },
    });

    await configHandlers["config.patch"](options);
    await flushConfigHandlerMicrotasks();

    expect(scheduleGatewaySigusr1RestartMock).toHaveBeenCalledTimes(1);
  });

  it("rejects config.set writes for locked cron namespaces", async () => {
    const prevConfig: OpenClawConfig = {};
    const nextConfig: OpenClawConfig = {
      cron: {
        enabled: true,
      },
    };
    readConfigFileSnapshotForWriteMock.mockResolvedValue(createConfigWriteSnapshot(prevConfig));
    const { options, respond } = createConfigHandlerHarness({
      method: "config.set",
      params: {
        raw: JSON.stringify(nextConfig),
        baseHash: "base-hash",
      },
      contextOverrides: {
        featureLocks: {
          cronLockedOff: true,
          channelsLockedOff: false,
        },
      },
    });

    await configHandlers["config.set"](options);

    expect(writeConfigFileMock).not.toHaveBeenCalled();
    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("startup feature lock active"),
      }),
    );
  });

  it("rejects config.patch writes for locked channel namespaces", async () => {
    const prevConfig: OpenClawConfig = {};
    readConfigFileSnapshotForWriteMock.mockResolvedValue(createConfigWriteSnapshot(prevConfig));
    const { options, respond } = createConfigHandlerHarness({
      method: "config.patch",
      params: {
        baseHash: "base-hash",
        raw: JSON.stringify({ channels: { telegram: { enabled: true } } }),
      },
      contextOverrides: {
        featureLocks: {
          cronLockedOff: false,
          channelsLockedOff: true,
        },
      },
    });

    await configHandlers["config.patch"](options);

    expect(writeConfigFileMock).not.toHaveBeenCalled();
    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("startup feature lock active"),
      }),
    );
  });

  it("rejects config.apply writes for locked channel startup namespaces", async () => {
    const prevConfig: OpenClawConfig = {};
    const nextConfig: OpenClawConfig = {
      gateway: {
        profile: "default",
      },
    };
    readConfigFileSnapshotForWriteMock.mockResolvedValue(createConfigWriteSnapshot(prevConfig));
    const { options, respond } = createConfigHandlerHarness({
      method: "config.apply",
      params: {
        raw: JSON.stringify(nextConfig),
        baseHash: "base-hash",
      },
      contextOverrides: {
        featureLocks: {
          cronLockedOff: false,
          channelsLockedOff: true,
        },
      },
    });

    await configHandlers["config.apply"](options);

    expect(writeConfigFileMock).not.toHaveBeenCalled();
    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("startup feature lock active"),
      }),
    );
  });

  it("allows unrelated gateway writes when channel locks do not change locked namespaces", async () => {
    const prevConfig: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "token",
          token: "old-token",
        },
      },
    };
    readConfigFileSnapshotForWriteMock.mockResolvedValue(createConfigWriteSnapshot(prevConfig));
    const { options } = createConfigHandlerHarness({
      method: "config.patch",
      params: {
        baseHash: "base-hash",
        raw: JSON.stringify({ gateway: { auth: { token: "new-token" } } }),
      },
      contextOverrides: {
        featureLocks: {
          cronLockedOff: false,
          channelsLockedOff: true,
        },
      },
    });

    await configHandlers["config.patch"](options);

    expect(writeConfigFileMock).toHaveBeenCalledTimes(1);
  });
});
