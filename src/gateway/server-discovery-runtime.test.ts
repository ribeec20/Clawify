import { beforeEach, describe, expect, it, vi } from "vitest";

const startGatewayBonjourAdvertiserWithTimeout = vi.hoisted(() => vi.fn());
const resolveTailnetDnsHint = vi.hoisted(() => vi.fn(async () => undefined));
const formatBonjourInstanceName = vi.hoisted(() => vi.fn((name: string) => name));
const resolveBonjourCliPath = vi.hoisted(() => vi.fn(() => "/usr/bin/openclaw"));
const pickPrimaryTailnetIPv4 = vi.hoisted(() => vi.fn(() => undefined));
const pickPrimaryTailnetIPv6 = vi.hoisted(() => vi.fn(() => undefined));
const resolveWideAreaDiscoveryDomain = vi.hoisted(() => vi.fn(() => undefined));
const writeWideAreaGatewayZone = vi.hoisted(() => vi.fn());

vi.mock("../infra/bonjour.js", () => ({
  startGatewayBonjourAdvertiserWithTimeout: (opts: unknown) =>
    startGatewayBonjourAdvertiserWithTimeout(opts),
}));

vi.mock("./server-discovery.js", () => ({
  formatBonjourInstanceName: (name: string) => formatBonjourInstanceName(name),
  resolveBonjourCliPath: () => resolveBonjourCliPath(),
  resolveTailnetDnsHint: (opts: unknown) => resolveTailnetDnsHint(opts),
}));

vi.mock("../infra/tailnet.js", () => ({
  pickPrimaryTailnetIPv4: () => pickPrimaryTailnetIPv4(),
  pickPrimaryTailnetIPv6: () => pickPrimaryTailnetIPv6(),
}));

vi.mock("../infra/widearea-dns.js", () => ({
  resolveWideAreaDiscoveryDomain: (params: unknown) => resolveWideAreaDiscoveryDomain(params),
  writeWideAreaGatewayZone: (params: unknown) => writeWideAreaGatewayZone(params),
}));

const { startGatewayDiscovery } = await import("./server-discovery-runtime.js");

describe("startGatewayDiscovery", () => {
  beforeEach(() => {
    startGatewayBonjourAdvertiserWithTimeout.mockReset();
    resolveTailnetDnsHint.mockReset();
    resolveTailnetDnsHint.mockResolvedValue(undefined);
    formatBonjourInstanceName.mockReset();
    formatBonjourInstanceName.mockImplementation((name: string) => name);
    resolveBonjourCliPath.mockReset();
    resolveBonjourCliPath.mockReturnValue("/usr/bin/openclaw");
    pickPrimaryTailnetIPv4.mockReset();
    pickPrimaryTailnetIPv4.mockReturnValue(undefined);
    pickPrimaryTailnetIPv6.mockReset();
    pickPrimaryTailnetIPv6.mockReturnValue(undefined);
    resolveWideAreaDiscoveryDomain.mockReset();
    resolveWideAreaDiscoveryDomain.mockReturnValue(undefined);
    writeWideAreaGatewayZone.mockReset();
  });

  it("keeps startup running when bonjour startup times out", async () => {
    startGatewayBonjourAdvertiserWithTimeout.mockRejectedValue(
      new Error("bonjour advertiser startup timed out after 5000ms"),
    );
    const info = vi.fn();
    const warn = vi.fn();

    const result = await startGatewayDiscovery({
      machineDisplayName: "OpenClaw",
      port: 18789,
      wideAreaDiscoveryEnabled: false,
      tailscaleMode: "off",
      logDiscovery: { info, warn },
    });

    expect(result.bonjourStop).toBeNull();
    expect(startGatewayBonjourAdvertiserWithTimeout).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("bonjour advertising failed"));
  });

  it("returns bonjour stop hook when bonjour starts", async () => {
    const stop = vi.fn(async () => {});
    startGatewayBonjourAdvertiserWithTimeout.mockResolvedValue({ stop });

    const result = await startGatewayDiscovery({
      machineDisplayName: "OpenClaw",
      port: 18789,
      wideAreaDiscoveryEnabled: false,
      tailscaleMode: "off",
      logDiscovery: { info: vi.fn(), warn: vi.fn() },
    });

    expect(result.bonjourStop).toBe(stop);
  });
});
