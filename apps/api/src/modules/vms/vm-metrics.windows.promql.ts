import type { VmMetricBinding } from './vm-metrics.promql.js';
import type { VmMetricExpressions } from './vms.types.js';
import { buildTelegrafVmExpressions } from './vm-metrics.telegraf-contract.js';

// Native cpu/mem/disk/net/system families; no exporter aliases or fictional
// win_perf_counters family. Windows runtime availability remains unverified.
export function buildWindowsVmExpressions(
  organizationId: string,
  bindings: VmMetricBinding[],
  staleSeconds: number,
): VmMetricExpressions {
  return buildTelegrafVmExpressions(organizationId, bindings, 'windows', staleSeconds);
}
