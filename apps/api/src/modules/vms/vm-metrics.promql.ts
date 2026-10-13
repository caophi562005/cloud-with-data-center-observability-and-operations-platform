import type { VmMetricExpressions, VmMetricPlatform } from './vms.types.js';
import { VM_HEALTH_POLICY } from './vm-health.js';
import { buildTelegrafVmExpressions } from './vm-metrics.telegraf-contract.js';

export const RANGE_METRICS = ['cpu', 'memory', 'disk', 'networkRx', 'networkTx', 'load'] as const;
export const CURRENT_METRICS = [...RANGE_METRICS, 'uptimeHours'] as const;
export type CurrentMetric = (typeof CURRENT_METRICS)[number];
export interface VmMetricBinding {
  vmId: string;
  agentId: string;
  platform: VmMetricPlatform;
}
export function buildLinuxVmExpressions(
  organizationId: string,
  bindings: VmMetricBinding[],
): VmMetricExpressions {
  return buildTelegrafVmExpressions(organizationId, bindings, 'linux', VM_HEALTH_POLICY.staleSeconds);
}

// Retained public builder for existing consumers. The native Linux profile has
// every current field; Windows deliberately omits load in its separate builder.
export function buildVmExpressions(
  organizationId: string,
  bindings: VmMetricBinding[],
): Record<CurrentMetric | 'current' | 'source' | 'lastSeen', string> {
  const { values, ...queries } = buildLinuxVmExpressions(organizationId, bindings);
  return { ...values, ...queries } as Record<CurrentMetric | 'current' | 'source' | 'lastSeen', string>;
}
