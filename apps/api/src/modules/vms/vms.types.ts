import type { AgentCollectorType, AgentStatus, VmStatus } from '@prisma/client';

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
  collectorType?: AgentCollectorType | null;
  collectorVersion?: string | null;
  buildId?: string | null;
  lastControlContactAt?: Date | null;
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
  // Zero denotes the legacy VM-bound path with no managed native profile.
  desiredVersion: number;
};

export type OrganizationInstallCodeResponse = {
  id: string;
  token: string;
  expiresAt: Date;
  maxUses: 1;
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
export type VmMetricsState = 'available' | 'empty' | 'disabled' | 'unavailable' | 'unsupported';
export type VmTelemetryMetadata = {
  collectorType: AgentCollectorType | null;
  collectorVersion: string | null;
  buildId: string | null;
  telemetryCompatibility: 'native' | 'legacy' | 'unknown';
  telemetryDelivery: 'fresh' | 'stale' | 'never-seen' | 'unknown' | 'unsupported';
  hostState: VmStatus | 'unknown' | 'unsupported';
  lastControlContactAt: string | null;
};
export type VmCurrentMetrics = VmTelemetryMetadata & {
  metricsCapabilities: VmMetricsCapabilities;
  sampledAt: string | null;
  lastSeenAt: string | null;
  status: VmStatus;
  metrics: VmMetrics;
  metricsState: VmMetricsState;
};
export type EnrichedVmRecord = VmRecord & VmTelemetryMetadata & {
  metricsCapabilities: VmMetricsCapabilities;
  metrics: VmMetrics;
  lastSeenAt: string | null;
  metricsState: VmMetricsState;
};
export type VmMetricPoint = { timestamp: string; value: number | null };
export type VmMetricsRange = VmTelemetryMetadata & {
  metricsState: VmMetricsState;
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
export const ORGANIZATION_INSTALL_CODE_TTL_SECONDS = 3_600;
