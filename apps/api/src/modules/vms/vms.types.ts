import type { AgentStatus, VmStatus } from '@prisma/client';

export type TagFilter = {
  key: string;
  value: string;
};

export type VmListFilters = {
  page: number;
  pageSize: number;
  tags: TagFilter[];
};

export type VmTagRecord = {
  id: string;
  key: string;
  value: string;
};

export type AgentSummary = {
  id: string;
  status: AgentStatus;
  enrolledAt: Date;
  lastSeenAt: Date | null;
};

export type VmRecord = {
  id: string;
  organizationId: string;
  hostname: string;
  ipAddress: string | null;
  os: string | null;
  status: VmStatus;
  createdAt: Date;
  updatedAt: Date;
  tags: VmTagRecord[];
  agent: AgentSummary | null;
};

export type VmPage = {
  items: VmRecord[];
  page: number;
  pageSize: number;
  total: number;
};

export type EnrollmentTokenPublic = {
  tokenId: string;
  token: string;
  expiresAt: Date;
};

export type VmCreateResponse = {
  vm: VmRecord;
  enrollment: EnrollmentTokenPublic;
};

export type AgentEnrollmentResponse = {
  agentId: string;
  organizationId: string;
  vmId: string;
  credential: string;
  status: 'ACTIVE';
};

export type TokenSeed = {
  hash: string;
  expiresAt: Date;
};

export type VmMetrics = {
  cpu: number | null;
  memory: number | null;
  disk: number | null;
  networkRx: number | null;
  networkTx: number | null;
  load: number | null;
  uptimeHours: number | null;
};
export type MetricName = keyof VmMetrics;
export type VmMetricPlatform = 'linux' | 'windows' | 'unknown';
export type VmMetricsCapabilities = {
  platform: VmMetricPlatform;
  supported: MetricName[];
};
export type VmMetricExpressions = {
  values: Partial<Record<MetricName, string>>;
  current: string;
  source: string;
  lastSeen: string;
};
export type VmMetricsState = 'available' | 'empty' | 'disabled' | 'unavailable';
export type VmCurrentMetrics = {
  metricsCapabilities: VmMetricsCapabilities;
  sampledAt: string | null;
  lastSeenAt: string | null;
  status: VmStatus;
  metrics: VmMetrics;
  metricsState: 'available' | 'empty';
};
export type EnrichedVmRecord = VmRecord & {
  metricsCapabilities: VmMetricsCapabilities;
  metrics: VmMetrics;
  lastSeenAt: string | null;
  metricsState: VmMetricsState;
};
export type VmMetricPoint = { timestamp: string; value: number | null };
export type VmMetricsRange = {
  metricsCapabilities: VmMetricsCapabilities;
  from: string;
  to: string;
  step: number;
  series: Record<
    'cpu' | 'memory' | 'disk' | 'networkRx' | 'networkTx' | 'load',
    VmMetricPoint[]
  >;
};
export const DEFAULT_ENROLLMENT_TOKEN_TTL_SECONDS = 86_400;
