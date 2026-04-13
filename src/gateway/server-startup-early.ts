import { registerSkillsChangeListener } from "../agents/skills/refresh.js";
import type { OpenClawConfig } from "../config/config.js";
import type { GatewayTailscaleMode } from "../config/types.gateway.js";
import { getMachineDisplayName } from "../infra/machine-name.js";
import {
  primeRemoteSkillsCache,
  refreshRemoteBinsForConnectedNodes,
  setSkillsRemoteRegistry,
} from "../infra/skills-remote.js";
import { startTaskRegistryMaintenance } from "../tasks/task-registry.maintenance.js";
import { startMcpLoopbackServer } from "./mcp-http.js";
import { startGatewayDiscovery } from "./server-discovery-runtime.js";
import { startGatewayMaintenanceTimers } from "./server-maintenance.js";

const GATEWAY_DISCOVERY_START_TIMEOUT_MS = 5_000;

class GatewayStartupTimeoutError extends Error {}

async function withStartupTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new GatewayStartupTimeoutError(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timeoutId.unref?.();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export async function startGatewayEarlyRuntime(params: {
  minimalTestGateway: boolean;
  cfgAtStart: OpenClawConfig;
  port: number;
  gatewayTls: { enabled: boolean; fingerprintSha256?: string };
  tailscaleMode: GatewayTailscaleMode;
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
  };
  logDiscovery: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
  };
  nodeRegistry: Parameters<typeof setSkillsRemoteRegistry>[0];
  broadcast: Parameters<typeof startGatewayMaintenanceTimers>[0]["broadcast"];
  nodeSendToAllSubscribed: Parameters<
    typeof startGatewayMaintenanceTimers
  >[0]["nodeSendToAllSubscribed"];
  getPresenceVersion: Parameters<typeof startGatewayMaintenanceTimers>[0]["getPresenceVersion"];
  getHealthVersion: Parameters<typeof startGatewayMaintenanceTimers>[0]["getHealthVersion"];
  refreshGatewayHealthSnapshot: Parameters<
    typeof startGatewayMaintenanceTimers
  >[0]["refreshGatewayHealthSnapshot"];
  logHealth: Parameters<typeof startGatewayMaintenanceTimers>[0]["logHealth"];
  dedupe: Parameters<typeof startGatewayMaintenanceTimers>[0]["dedupe"];
  chatAbortControllers: Parameters<typeof startGatewayMaintenanceTimers>[0]["chatAbortControllers"];
  chatRunState: Parameters<typeof startGatewayMaintenanceTimers>[0]["chatRunState"];
  chatRunBuffers: Parameters<typeof startGatewayMaintenanceTimers>[0]["chatRunBuffers"];
  chatDeltaSentAt: Parameters<typeof startGatewayMaintenanceTimers>[0]["chatDeltaSentAt"];
  chatDeltaLastBroadcastLen: Parameters<
    typeof startGatewayMaintenanceTimers
  >[0]["chatDeltaLastBroadcastLen"];
  removeChatRun: Parameters<typeof startGatewayMaintenanceTimers>[0]["removeChatRun"];
  agentRunSeq: Parameters<typeof startGatewayMaintenanceTimers>[0]["agentRunSeq"];
  nodeSendToSession: Parameters<typeof startGatewayMaintenanceTimers>[0]["nodeSendToSession"];
  mediaCleanupTtlMs?: number;
  skillsRefreshDelayMs: number;
  getSkillsRefreshTimer: () => ReturnType<typeof setTimeout> | null;
  setSkillsRefreshTimer: (timer: ReturnType<typeof setTimeout> | null) => void;
  loadConfig: () => OpenClawConfig;
}) {
  let mcpServer: { port: number; close: () => Promise<void> } | undefined;
  try {
    mcpServer = await startMcpLoopbackServer(0);
    params.log.info(`MCP loopback server listening on http://127.0.0.1:${mcpServer.port}/mcp`);
  } catch (error) {
    params.log.warn(`MCP loopback server failed to start: ${String(error)}`);
  }

  let bonjourStop: (() => Promise<void>) | null = null;
  if (!params.minimalTestGateway) {
    const machineDisplayName = await getMachineDisplayName();
    const discoveryStartup = startGatewayDiscovery({
      machineDisplayName,
      port: params.port,
      gatewayTls: params.gatewayTls.enabled
        ? { enabled: true, fingerprintSha256: params.gatewayTls.fingerprintSha256 }
        : undefined,
      wideAreaDiscoveryEnabled: params.cfgAtStart.discovery?.wideArea?.enabled === true,
      wideAreaDiscoveryDomain: params.cfgAtStart.discovery?.wideArea?.domain,
      tailscaleMode: params.tailscaleMode,
      mdnsMode: params.cfgAtStart.discovery?.mdns?.mode,
      logDiscovery: params.logDiscovery,
    });
    try {
      const discovery = await withStartupTimeout(
        discoveryStartup,
        GATEWAY_DISCOVERY_START_TIMEOUT_MS,
        "gateway discovery startup",
      );
      bonjourStop = discovery.bonjourStop;
    } catch (error) {
      if (!(error instanceof GatewayStartupTimeoutError)) {
        throw error;
      }
      params.logDiscovery.warn(`gateway discovery startup skipped: ${String(error)}`);
      void discoveryStartup
        .then(async (lateDiscovery) => {
          if (!lateDiscovery.bonjourStop) {
            return;
          }
          try {
            await lateDiscovery.bonjourStop();
          } catch {
            // ignore late cleanup errors
          }
        })
        .catch(() => {
          // ignore late startup failures
        });
    }
  }

  if (!params.minimalTestGateway) {
    setSkillsRemoteRegistry(params.nodeRegistry);
    void primeRemoteSkillsCache();
    startTaskRegistryMaintenance();
  }

  const skillsChangeUnsub = params.minimalTestGateway
    ? () => {}
    : registerSkillsChangeListener((event) => {
        if (event.reason === "remote-node") {
          return;
        }
        const existingTimer = params.getSkillsRefreshTimer();
        if (existingTimer) {
          clearTimeout(existingTimer);
        }
        const nextTimer = setTimeout(() => {
          params.setSkillsRefreshTimer(null);
          void refreshRemoteBinsForConnectedNodes(params.loadConfig());
        }, params.skillsRefreshDelayMs);
        params.setSkillsRefreshTimer(nextTimer);
      });

  const maintenance = params.minimalTestGateway
    ? null
    : startGatewayMaintenanceTimers({
        broadcast: params.broadcast,
        nodeSendToAllSubscribed: params.nodeSendToAllSubscribed,
        getPresenceVersion: params.getPresenceVersion,
        getHealthVersion: params.getHealthVersion,
        refreshGatewayHealthSnapshot: params.refreshGatewayHealthSnapshot,
        logHealth: params.logHealth,
        dedupe: params.dedupe,
        chatAbortControllers: params.chatAbortControllers,
        chatRunState: params.chatRunState,
        chatRunBuffers: params.chatRunBuffers,
        chatDeltaSentAt: params.chatDeltaSentAt,
        chatDeltaLastBroadcastLen: params.chatDeltaLastBroadcastLen,
        removeChatRun: params.removeChatRun,
        agentRunSeq: params.agentRunSeq,
        nodeSendToSession: params.nodeSendToSession,
        ...(typeof params.mediaCleanupTtlMs === "number"
          ? { mediaCleanupTtlMs: params.mediaCleanupTtlMs }
          : {}),
      });

  return {
    mcpServer,
    bonjourStop,
    skillsChangeUnsub,
    maintenance,
  };
}
