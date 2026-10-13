export const VM_STATUSES = ["HEALTHY", "WARNING", "CRITICAL", "DISCONNECTED"] as const;
export type VmStatus = (typeof VM_STATUSES)[number];
export type VmOsType = "Linux" | "Windows" | "Unknown";
export type VmAgentStatus = "ACTIVE" | "REVOKED";
export const VM_TIME_RANGES = ["1h", "6h", "24h", "7d"] as const;
export type VmTimeRange = (typeof VM_TIME_RANGES)[number];
export type VmMetricsState = "available" | "empty" | "disabled" | "unavailable" | "unsupported";
export type VmHostState = VmStatus | "unknown" | "unsupported";
export const VM_HOST_STATES = [...VM_STATUSES, "unknown", "unsupported"] as const;
export interface VmTelemetryMetadata {
  collectorType: "TELEGRAF" | "ALLOY" | null;
  collectorVersion: string | null;
  buildId: string | null;
  telemetryCompatibility: "native" | "legacy" | "unknown";
  telemetryDelivery: "fresh" | "stale" | "never-seen" | "unknown" | "unsupported";
  hostState: VmHostState;
  lastControlContactAt: string | null;
}
export interface VmAgentSummary {
  id: string;
  status: VmAgentStatus;
  enrolledAt: string;
  lastSeenAt: string | null;
  collectorType?: VmTelemetryMetadata["collectorType"];
  collectorVersion?: string | null;
  buildId?: string | null;
  lastControlContactAt?: string | null;
}
export interface VmMetrics {
  cpu: number | null;
  memory: number | null;
  disk: number | null;
  networkRx: number | null;
  networkTx: number | null;
  load: number | null;
  uptimeHours: number | null;
}
export type MetricName = keyof VmMetrics;
export type VmMetricPlatform = "linux" | "windows" | "unknown";
export type VmMetricsCapabilities = {
  platform: VmMetricPlatform;
  supported: MetricName[];
};
export type VmChartMetric = Exclude<MetricName, "uptimeHours">;
export interface VmMetricPoint { timestamp: string; value: number | null }
export interface VmMetricsRange extends VmTelemetryMetadata {
  metricsState: VmMetricsState;
  metricsCapabilities?: VmMetricsCapabilities;
  from: string;
  to: string;
  step: number;
  series: Record<VmChartMetric, VmMetricPoint[]>;
}
export interface VmCurrentMetrics extends VmTelemetryMetadata {
  metricsCapabilities?: VmMetricsCapabilities;
  sampledAt: string | null;
  lastSeenAt: string | null;
  status: VmStatus;
  metrics: VmMetrics;
  metricsState: VmMetricsState;
}
export interface Vm extends VmTelemetryMetadata {
  id: string;
  hostname: string;
  osType: VmOsType;
  osVersion: string;
  ipAddress: string;
  status: VmStatus;
  tags: Record<string, string>;
  tagIds?: Record<string, string>;
  agentStatus?: VmAgentStatus | null;
  agent: VmAgentSummary | null;
  lastSeenAt: string | null;
  createdAt: string;
  metrics: VmMetrics | null;
  metricsState?: VmMetricsState;
  metricsCapabilities?: VmMetricsCapabilities;
}
export interface VmFilters { query: string; status: VmHostState | "ALL"; tags: string[] }
export type VmGroupBy = "none" | "os" | "status" | "untagged" | `tag:${string}`;
