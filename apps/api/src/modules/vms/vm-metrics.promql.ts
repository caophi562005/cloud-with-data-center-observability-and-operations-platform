import type { VmMetricExpressions, VmMetricPlatform } from './vms.types.js';

const GROUP = 'organization_id,vm_id,agent_id';
export const RANGE_METRICS = [
  'cpu',
  'memory',
  'disk',
  'networkRx',
  'networkTx',
  'load',
] as const;
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
  const { current, source, lastSeen, ...values } = buildVmExpressions(organizationId, bindings);
  return { values, current, source, lastSeen };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function mark(expression: string, name: string): string {
  return `label_replace((${expression}), "__ops_metric", "${name}", "", "")`;
}
export function buildVmExpressions(
  organizationId: string,
  bindings: VmMetricBinding[],
): Record<CurrentMetric | 'current' | 'source' | 'lastSeen', string> {
  const vmIds = [...new Set(bindings.map((b) => escapeRegex(b.vmId)))].join(
    '|',
  );
  const agentIds = [
    ...new Set(bindings.map((b) => escapeRegex(b.agentId))),
  ].join('|');
  const scope = `organization_id=${JSON.stringify(organizationId)},vm_id=~${JSON.stringify(vmIds)},agent_id=~${JSON.stringify(agentIds)}`;
  const metric = (name: string, extra = '') => `${name}{${scope}${extra}}`;
  const avg = (q: string) => `avg by (${GROUP}) (${q})`;
  const max = (q: string) => `max by (${GROUP}) (${q})`;
  const min = (q: string) => `min by (${GROUP}) (${q})`;
  const sum = (q: string) => `sum by (${GROUP}) (${q})`;
  const cpu = metric('node_cpu_seconds_total', ',mode="idle"');
  const available = metric('node_memory_MemAvailable_bytes');
  const total = metric('node_memory_MemTotal_bytes');
  const fs =
    ',fstype!~"tmpfs|devtmpfs|proc|sysfs|overlay|squashfs|nsfs|tracefs|cgroup2?",mountpoint!~"/run($|/.*)|/var/lib/(docker|containers)($|/.*)"';
  const diskSize = metric('node_filesystem_size_bytes', fs);
  const diskAvailable = metric('node_filesystem_avail_bytes', fs);
  const rx = metric('node_network_receive_bytes_total', ',device!="lo"');
  const tx = metric('node_network_transmit_bytes_total', ',device!="lo"');
  const load = metric('node_load1');
  const boot = metric('node_boot_time_seconds');
  const expressions = {
    cpu: `clamp_max(clamp_min((1 - ${avg(`rate(${cpu}[5m])`)}) * 100, 0), 100)`,
    memory: `clamp_max(clamp_min((1 - ${max(available)} / (${max(total)} > 0)) * 100, 0), 100)`,
    disk: `clamp_max(clamp_min(${max(`(1 - ${diskAvailable} / (${diskSize} > 0)) * 100`)}, 0), 100)`,
    networkRx: `${sum(`rate(${rx}[5m])`)} * 8 / 1000000`,
    networkTx: `${sum(`rate(${tx}[5m])`)} * 8 / 1000000`,
    load: max(load),
    uptimeHours: `clamp_min((time() - ${max(boot)}) / 3600, 0)`,
  };
  // timestamp() removes metric names, so distinguish constituents before OR:
  // otherwise the left side hides a stale denominator with identical labels.
  const source = (q: string, name: string) =>
    `label_replace(timestamp(${q}), "__ops_source", "${name}", "", "")`;
  const sources = {
    cpu: min(`timestamp(${cpu})`),
    memory: min(
      `${source(available, 'available')} or ${source(total, 'total')}`,
    ),
    disk: min(
      `${source(diskAvailable, 'available')} or ${source(diskSize, 'size')}`,
    ),
    networkRx: min(`timestamp(${rx})`),
    networkTx: min(`timestamp(${tx})`),
    load: min(`timestamp(${load})`),
    uptimeHours: min(`timestamp(${boot})`),
  };
  // A partially reporting host is still connected. Use the latest actual raw
  // sample across eligible families, not a memory-total-only heartbeat. Mark
  // each family before OR because timestamp() removes the original metric name.
  const latest = max(
    [
      source(cpu, 'cpu'),
      source(available, 'memoryAvailable'),
      source(total, 'memoryTotal'),
      source(diskAvailable, 'diskAvailable'),
      source(diskSize, 'diskSize'),
      source(rx, 'networkRx'),
      source(tx, 'networkTx'),
      source(load, 'load'),
      source(boot, 'uptimeHours'),
    ].join(' or '),
  );
  return {
    ...expressions,
    current: CURRENT_METRICS.map((name) => mark(expressions[name], name)).join(
      ' or ',
    ),
    source: [
      ...CURRENT_METRICS.map((name) => mark(sources[name], name)),
      mark(latest, 'heartbeat'),
    ].join(' or '),
    lastSeen: mark(max(`max_over_time((${latest})[7d:60s])`), 'heartbeat'),
  };
}
