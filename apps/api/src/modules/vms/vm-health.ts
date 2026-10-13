import type { VmStatus } from '@prisma/client';
import type { VmMetrics } from './vms.types.js';
import { DEFAULT_VM_HEALTH_POLICY } from '../../config/env.schema.js';
import type { VmHealthPolicy } from '../../config/metrics.config.js';
export const VM_HEALTH_POLICY = DEFAULT_VM_HEALTH_POLICY;
export function emptyVmMetrics(): VmMetrics {
  return {
    cpu: null,
    memory: null,
    disk: null,
    networkRx: null,
    networkTx: null,
    load: null,
    uptimeHours: null,
  };
}
export function deriveVmHealth(
  metrics: VmMetrics,
  active: boolean,
  sampledAt: number | null,
  now: number,
  policy: VmHealthPolicy = VM_HEALTH_POLICY,
): VmStatus | 'unknown' {
  if (!Number.isFinite(now) || now <= 0 || (sampledAt !== null && !Number.isFinite(sampledAt)))
    return 'unknown';
  if (
    !active ||
    sampledAt === null ||
    sampledAt > now ||
    now - sampledAt > policy.staleSeconds
  )
    return 'DISCONNECTED';
  const percents = [metrics.cpu, metrics.memory, metrics.disk].filter(
    (n): n is number => n !== null && Number.isFinite(n),
  );
  if (percents.some((n) => n >= policy.critical)) return 'CRITICAL';
  if (
    (metrics.cpu !== null && metrics.cpu >= policy.cpuWarning) ||
    (metrics.memory !== null && metrics.memory >= policy.memoryWarning) ||
    (metrics.disk !== null && metrics.disk >= policy.diskWarning)
  )
    return 'WARNING';
  return Object.values(metrics).some((n) => n !== null && Number.isFinite(n))
    ? 'HEALTHY'
    : 'unknown'; // Fresh internal delivery alone is not usable host telemetry.
}
