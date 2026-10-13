import type { AgentIdentity, IntegrationInstance, IntegrationKind, SupportedAgentOs } from './monitoring.types.js';

export type IntegrationMetricState = 'fresh' | 'stale' | 'no-data' | 'not-applicable' | 'unsupported';
export type IntegrationMetricsRange = '15m' | '1h' | '6h' | '24h';
export type IntegrationMetricDefinition = {
  key: string; label: string; group: string; unit: string;
  semanticType: 'gauge' | 'counter' | 'rate' | 'ratio'; description: string; chart: boolean;
};
export type IntegrationMetricReading = {
  key: string; entityKey: string | null; value: number | null; lastSampleAt: string | null;
  state: IntegrationMetricState; reason: string | null;
};
export type IntegrationMetricEntity = { key: string; label: string };
export type IntegrationMetricsCurrent = {
  kind: IntegrationKind; instanceId: string; queriedAt: string; enabled: boolean;
  dataState: 'fresh' | 'stale' | 'no-data' | 'disabled' | 'unsupported'; lastSampleAt: string | null;
  definitions: IntegrationMetricDefinition[]; readings: IntegrationMetricReading[];
  entities: IntegrationMetricEntity[]; entitiesTruncated: boolean;
};
export type IntegrationMetricsHistory = {
  kind: IntegrationKind; instanceId: string; key: string; entityKey: string | null;
  range: IntegrationMetricsRange; from: string; to: string; step: number;
  points: Array<{ timestamp: string; value: number | null }>; state: IntegrationMetricState; reason: string | null;
};
export type IntegrationQueryContext = {
  identity: AgentIdentity | null; os: SupportedAgentOs | null; instance: IntegrationInstance; compatible: boolean;
};
