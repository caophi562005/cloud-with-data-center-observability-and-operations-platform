import type { Vm, VmMetrics, VmTelemetryMetadata } from "../../src/features/vms/vm.types";

export const linuxCapabilities = { platform: "linux" as const, supported: ["cpu", "memory", "disk", "networkRx", "networkTx", "load", "uptimeHours"] as Array<keyof VmMetrics> };
export const windowsCapabilities = { platform: "windows" as const, supported: ["cpu", "memory", "disk", "networkRx", "networkTx", "uptimeHours"] as Array<keyof VmMetrics> };
export const unknownCapabilities = { platform: "unknown" as const, supported: [] as Array<keyof VmMetrics> };
export const unknownTelemetry: VmTelemetryMetadata = {
  collectorType: null, collectorVersion: null, buildId: null,
  telemetryCompatibility: "unknown", telemetryDelivery: "unknown", hostState: "unknown", lastControlContactAt: null,
};
export const nativeTelemetry: VmTelemetryMetadata = {
  collectorType: "TELEGRAF", collectorVersion: null, buildId: "opsgrid-custom-6ab4b57bbaede19d",
  telemetryCompatibility: "native", telemetryDelivery: "fresh", hostState: "HEALTHY", lastControlContactAt: null,
};
const base: Omit<Vm, "id" | "hostname" | "status" | "tags" | "osType"> = {
  ...unknownTelemetry, agent: null, agentStatus: null,
  osVersion: "Test OS", ipAddress: "192.0.2.1", lastSeenAt: null,
  createdAt: "2026-10-01T00:00:00Z", metrics: null, metricsState: "empty", tagIds: {},
};
// Static domain DTOs: explicit native host state is independent of retained DB status.
const native = { ...nativeTelemetry, lastSeenAt: "2026-10-04T00:00:00Z" };
export const inventoryFixtures: Vm[] = [
  { ...base, ...native, id: "one", hostname: "edge-linux-01", osType: "Linux", status: "HEALTHY", tags: { site: "sea-01", env: "production" } },
  { ...base, ...native, id: "two", hostname: "api-prod-01", osType: "Linux", status: "WARNING", hostState: "WARNING", tags: { site: "iad-01", env: "production" } },
  { ...base, ...native, id: "three", hostname: "db-primary-01", osType: "Linux", status: "CRITICAL", hostState: "CRITICAL", tags: { site: "iad-01", role: "database", env: "production" } },
  { ...base, ...native, id: "four", hostname: "win-node-01", osType: "Windows", status: "DISCONNECTED", hostState: "DISCONNECTED", telemetryDelivery: "stale", tags: {} },
  { ...base, id: "five", hostname: "new-node-01", osType: "Windows", status: "DISCONNECTED", tags: {} },
];
