export const VM_STATUSES = ["HEALTHY", "WARNING", "CRITICAL", "DISCONNECTED"] as const;
export type VmStatus = (typeof VM_STATUSES)[number];
export type VmOsType = "Linux" | "Windows" | "Unknown";
export type VmAgentStatus = "ACTIVE" | "REVOKED";
export const VM_TIME_RANGES = ["1h", "6h", "24h", "7d"] as const;
export type VmTimeRange = (typeof VM_TIME_RANGES)[number];
export type VmMetricsState = "available" | "empty" | "disabled" | "unavailable";
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
export interface VmMetricsRange {
  metricsCapabilities?: VmMetricsCapabilities;
  from: string;
  to: string;
  step: number;
  series: Record<VmChartMetric, VmMetricPoint[]>;
}
export interface VmCurrentMetrics {
  metricsCapabilities?: VmMetricsCapabilities;
  sampledAt: string | null;
  lastSeenAt: string | null;
  status: VmStatus;
  metrics: VmMetrics;
  metricsState: "available" | "empty";
}
export interface Vm {
  id: string;
  hostname: string;
  osType: VmOsType;
  osVersion: string;
  ipAddress: string;
  status: VmStatus;
  tags: Record<string, string>;
  tagIds?: Record<string, string>;
  agentStatus?: VmAgentStatus | null;
  lastSeenAt: string | null;
  createdAt: string;
  metrics: VmMetrics | null;
  metricsState?: VmMetricsState;
  metricsCapabilities?: VmMetricsCapabilities;
}
export interface VmFilters { query: string; status: VmStatus | "ALL"; tags: string[] }
export type VmGroupBy = "none" | "os" | "status" | "untagged" | `tag:${string}`;
