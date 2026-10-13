import type { VmMetricBinding } from './vm-metrics.promql.js';
import type { VmMetricExpressions, VmMetricPlatform, VmRecord } from './vms.types.js';
import { resolveVmMetricPlatform } from './vm-metrics-capabilities.js';

// Source-derived from deploy/agent/telegraf/metrics-contract.json and the native
// renderer. This is NOT a serialized fixture or Linux/Windows runtime attestation.
export const TELEGRAF_CONTRACT_VERSION = 'telegraf-native-v1';
export const TELEGRAF_DELIVERY_FAMILY = 'internal_agent_metrics_gathered';
export const TELEGRAF_SERVICE_FAMILIES = {
  redis: ['redis_clients', 'redis_used_memory'],
  postgresql: ['postgresql_numbackends'],
  mysql: ['mysql_threads_connected'],
  nginx: ['nginx_active'],
  docker: ['docker_n_containers_running'],
} as const;
export const TELEGRAF_GROUP = 'organization_id,vm_id,agent_id';
export const escapeMetricRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const markMetric = (query: string, name: string, label = '__ops_metric') =>
  `label_replace((${query}), "${label}", "${name}", "", "")`;
export const finiteNonnegative = (query: string, positive = false) =>
  `((${query} ${positive ? '> 0' : '>= 0'}) < +Inf)`;

export function telemetryCompatibility(vm: VmRecord): 'native' | 'legacy' | 'unknown' {
  if (vm.agent?.collectorType === 'ALLOY') return 'legacy';
  return vm.agent?.collectorType === 'TELEGRAF' && resolveVmMetricPlatform(vm.os) !== 'unknown'
    ? 'native' : 'unknown';
}
export function nativeTelemetryActive(vm: VmRecord): boolean {
  return vm.agent?.status === 'ACTIVE' && telemetryCompatibility(vm) === 'native';
}

export function buildTelegrafVmExpressions(
  organizationId: string,
  bindings: VmMetricBinding[],
  platform: Exclude<VmMetricPlatform, 'unknown'>,
  staleSeconds: number,
): VmMetricExpressions {
  if (!Number.isFinite(staleSeconds) || staleSeconds < 0 || !bindings.length || bindings.length > 100)
    throw new Error('Invalid native metric scope');
  const vmIds = [...new Set(bindings.map((binding) => escapeMetricRegex(binding.vmId)))].join('|');
  const agentIds = [...new Set(bindings.map((binding) => escapeMetricRegex(binding.agentId)))].join('|');
  // Trusted gateway identities; grouped reads are rechecked against each exact
  // current VM/agent pair by the service before any value reaches a DTO.
  const scope = bindings.length === 1
    ? `organization_id=${JSON.stringify(organizationId)},vm_id=${JSON.stringify(bindings[0].vmId)},agent_id=${JSON.stringify(bindings[0].agentId)}`
    : `organization_id=${JSON.stringify(organizationId)},vm_id=~${JSON.stringify(vmIds)},agent_id=~${JSON.stringify(agentIds)}`;
  const raw = (name: string, extra = '') => `${name}{${scope}${extra}}`;
  const aggregate = (operation: string, query: string) => `${operation} by (${TELEGRAF_GROUP}) (${query})`;
  // All freshness predicates address RAW selectors, including at range evaluation
  // time. Never timestamp a rate, arithmetic result or subquery evaluation.
  const fresh = (query: string, valid = finiteNonnegative(query)) =>
    `(${valid} and (time() - timestamp(${query}) <= ${staleSeconds}) and (timestamp(${query}) <= time()))`;
  const cpu = raw('cpu_usage_idle', ',cpu="cpu-total"');
  const available = raw('mem_available');
  const total = raw('mem_total');
  // Match on ALL retained native labels (path/device/fstype/mode) before host max.
  // Linux excludes read-only, pseudo, temporary and duplicate container mounts.
  // Windows accepts only native drive-root paths, not the old exporter volume tag.
  const diskLabels = platform === 'linux'
    ? ',path=~"/.*",device!="",fstype!="",mode="rw",fstype!~"tmpfs|devtmpfs|devfs|proc|sysfs|overlay|aufs|squashfs|nsfs|tracefs|debugfs|securityfs|configfs|fusectl|mqueue|hugetlbfs|ramfs|autofs|iso9660|cgroup2?",path!~"/run($|/.*)|/var/lib/(docker|containers)($|/.*)"'
    : `,path=~${JSON.stringify('^[A-Za-z]:[\\\\/]?$')},device!="",fstype=~"(?i:ntfs|refs|fat|fat32|exfat)",mode="rw"`;
  const free = raw('disk_free', diskLabels);
  const size = raw('disk_total', diskLabels);
  const interfaceLabels = platform === 'linux'
    ? ',interface!="",interface!~"lo|lo[0-9]+|veth.*|docker[0-9]+|br-.*|cni.*|flannel.*|cali.*|virbr.*"'
    : ',interface!="",interface!~"(?i:.*loopback.*|isatap.*|teredo.*|.*pseudo-interface.*)"';
  const rx = raw('net_bytes_recv', interfaceLabels);
  const tx = raw('net_bytes_sent', interfaceLabels);
  const uptime = raw('system_uptime');
  const load = raw('system_load1');
  const delivery = raw(TELEGRAF_DELIVERY_FAMILY);
  const idleValid = `(${finiteNonnegative(cpu)} <= 100)`;
  const memoryPair = `(${fresh(available)} <= ${fresh(total, finiteNonnegative(total, true))})`;
  const diskPair = `(${fresh(free)} <= ${fresh(size, finiteNonnegative(size, true))})`;
  const idleWindow = `(avg_over_time(${cpu}[5m]) and ${fresh(cpu, idleValid)} and (min_over_time(${cpu}[5m]) >= 0) and (max_over_time(${cpu}[5m]) <= 100))`;
  const networkRate = (query: string) =>
    `(${finiteNonnegative(`rate(${query}[5m])`)} and ${fresh(query)} and (min_over_time(${query}[5m]) >= 0))`;
  const values: VmMetricExpressions['values'] = {
    cpu: `100 - ${aggregate('avg', idleWindow)}`,
    memory: aggregate('max', `(1 - ${memoryPair} / ${fresh(total, finiteNonnegative(total, true))}) * 100`),
    disk: aggregate('max', `(1 - ${diskPair} / ${fresh(size, finiteNonnegative(size, true))}) * 100`),
    networkRx: `${aggregate('sum', networkRate(rx))} * 8 / 1000000`,
    networkTx: `${aggregate('sum', networkRate(tx))} * 8 / 1000000`,
    uptimeHours: `${aggregate('max', fresh(uptime))} / 3600`,
    ...(platform === 'linux' ? { load: aggregate('max', fresh(load)) } : {}),
  };
  const rawTime = (query: string, eligible: string) => `(timestamp(${query}) and ${eligible})`;
  const pairTime = (numerator: string, denominator: string, pair: string, role: string) =>
    aggregate('min', `${markMetric(rawTime(numerator, pair), role, '__ops_source')} or ${markMetric(rawTime(denominator, pair), 'total', '__ops_source')}`);
  const sources = {
    cpu: aggregate('min', rawTime(cpu, fresh(cpu, idleValid))),
    memory: pairTime(available, total, memoryPair, 'available'),
    disk: pairTime(free, size, diskPair, 'free'),
    networkRx: aggregate('min', rawTime(rx, fresh(rx))),
    networkTx: aggregate('min', rawTime(tx, fresh(tx))),
    uptimeHours: aggregate('min', rawTime(uptime, fresh(uptime))),
    ...(platform === 'linux' ? { load: aggregate('min', rawTime(load, fresh(load))) } : {}),
  };
  // Delivery is ONLY this internal family's raw timestamp, never its counter
  // value, a host family, API contact or DB inventory lastSeenAt.
  const deliveryTime = aggregate('max', rawTime(delivery,
    `(${finiteNonnegative(delivery)} and (timestamp(${delivery}) <= time()))`));
  return {
    values,
    current: Object.entries(values).map(([name, query]) => markMetric(query, name)).join(' or '),
    source: [...Object.entries(sources).map(([name, query]) => markMetric(query, name)), markMetric(deliveryTime, 'heartbeat')].join(' or '),
    lastSeen: markMetric(aggregate('max', `max_over_time((${deliveryTime})[7d:60s])`), 'heartbeat'),
  };
}
