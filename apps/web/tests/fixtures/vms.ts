import type { Vm, VmMetrics } from "../../src/features/vms/vm.types";

export const linuxCapabilities = { platform: "linux" as const, supported: ["cpu", "memory", "disk", "networkRx", "networkTx", "load", "uptimeHours"] as Array<keyof VmMetrics> };
export const windowsCapabilities = { platform: "windows" as const, supported: ["cpu", "memory", "disk", "networkRx", "networkTx", "uptimeHours"] as Array<keyof VmMetrics> };
export const unknownCapabilities = { platform: "unknown" as const, supported: [] as Array<keyof VmMetrics> };
const base: Omit<Vm, "id" | "hostname" | "status" | "tags" | "osType"> = {
  osVersion: "Test OS", ipAddress: "192.0.2.1", lastSeenAt: null,
  createdAt: "2026-10-01T00:00:00Z", metrics: null, metricsState: "empty", tagIds: {},
};
/** Small static domain fixtures only: no fake telemetry, store, or mutations. */
export const inventoryFixtures: Vm[] = [
  { ...base, id: "one", hostname: "edge-linux-01", osType: "Linux", status: "HEALTHY", tags: { site: "sea-01", env: "production" } },
  { ...base, id: "two", hostname: "api-prod-01", osType: "Linux", status: "WARNING", tags: { site: "iad-01", env: "production" } },
  { ...base, id: "three", hostname: "db-primary-01", osType: "Linux", status: "CRITICAL", tags: { site: "iad-01", role: "database", env: "production" } },
  { ...base, id: "four", hostname: "win-node-01", osType: "Windows", status: "DISCONNECTED", tags: {} },
  { ...base, id: "five", hostname: "new-node-01", osType: "Windows", status: "DISCONNECTED", agentStatus: null, tags: {} },
];
