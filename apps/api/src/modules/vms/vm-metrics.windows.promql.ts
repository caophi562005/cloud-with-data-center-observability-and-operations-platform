import type { VmMetricBinding } from './vm-metrics.promql.js';
import type { VmMetricExpressions } from './vms.types.js';

const GROUP = 'organization_id,vm_id,agent_id';
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mark = (q: string, name: string, label = '__ops_metric') =>
  `label_replace((${q}), "${label}", "${name}", "", "")`;

// Locked observed mapping v1; target/component labels remain intact until final
// aggregation. In particular, never join disks by host before matching volume.
export function buildWindowsVmExpressions(
  organizationId: string,
  bindings: VmMetricBinding[],
  staleSeconds: number,
): VmMetricExpressions {
  if (!Number.isFinite(staleSeconds) || staleSeconds < 0)
    throw new Error('Invalid staleSeconds');
  const vmIds = [...new Set(bindings.map((b) => escapeRegex(b.vmId)))].join('|');
  const agentIds = [...new Set(bindings.map((b) => escapeRegex(b.agentId)))].join('|');
  const scope = `organization_id=${JSON.stringify(organizationId)},vm_id=~${JSON.stringify(vmIds)},agent_id=~${JSON.stringify(agentIds)}`;
  const raw = (name: string, extra = '') => `${name}{${scope}${extra}}`;
  const cpu = raw('windows_cpu_time_total', ',core=~"^[0-9]+,[0-9]+$",mode="idle"');
  const available = raw('windows_memory_available_bytes');
  const total = raw('windows_memory_physical_total_bytes');
  const free = raw('windows_logical_disk_free_bytes', ',volume=~"^[A-Za-z]:$"');
  const size = raw('windows_logical_disk_size_bytes', ',volume=~"^[A-Za-z]:$"');
  const nic = ',nic!="",nic!~"^Software Loopback Interface( [0-9]+)?$"';
  const rx = raw('windows_net_bytes_received_total', nic);
  const tx = raw('windows_net_bytes_sent_total', nic);
  const boot = raw('windows_system_boot_time_timestamp');
  const aggregate = (op: string, q: string) => `${op} by (${GROUP}) (${q})`;
  const valid = (q: string, positive = false) => `((${q} ${positive ? '> 0' : '>= 0'}) < +Inf)`;
  // timestamp() is always applied to RAW selectors, never to rate/arithmetic.
  // Default vector matching retains identity, target and device labels.
  const fresh = (q: string, eligible = valid(q)) =>
    `(${eligible} and (time() - timestamp(${q}) <= ${staleSeconds}) and (timestamp(${q}) <= time()))`;
  const bootValid = `(${valid(boot, true)} <= time())`;
  const memoryPair = `(${fresh(available)} <= ${fresh(total, valid(total, true))})`;
  const diskPair = `(${fresh(free)} <= ${fresh(size, valid(size, true))})`;
  const values = {
    cpu: `clamp_max(clamp_min((1 - ${aggregate('avg', `(rate(${cpu}[5m]) and ${fresh(cpu)})`)}) * 100, 0), 100)`,
    memory: aggregate('max', `(1 - ${memoryPair} / ${fresh(total, valid(total, true))}) * 100`),
    disk: aggregate('max', `(1 - ${diskPair} / ${fresh(size, valid(size, true))}) * 100`),
    networkRx: `${aggregate('sum', `(rate(${rx}[5m]) and ${fresh(rx)})`)} * 8 / 1000000`,
    networkTx: `${aggregate('sum', `(rate(${tx}[5m]) and ${fresh(tx)})`)} * 8 / 1000000`,
    uptimeHours: `(time() - ${aggregate('max', fresh(boot, bootValid))}) / 3600`,
  };
  const rawTime = (q: string, eligible: string) => `(timestamp(${q}) and ${eligible})`;
  const compositeTime = (numerator: string, denominator: string, pair: string, role: string) =>
    aggregate('min', `${mark(rawTime(numerator, pair), role, '__ops_source')} or ${mark(rawTime(denominator, pair), denominator === total ? 'total' : 'size', '__ops_source')}`);
  const sources = {
    cpu: aggregate('min', rawTime(cpu, fresh(cpu))),
    memory: compositeTime(available, total, memoryPair, 'available'),
    disk: compositeTime(free, size, diskPair, 'free'),
    networkRx: aggregate('min', rawTime(rx, fresh(rx))),
    networkTx: aggregate('min', rawTime(tx, fresh(tx))),
    uptimeHours: aggregate('min', rawTime(boot, fresh(boot, bootValid))),
  };
  // Heartbeat/history use eligible raw samples even when stale today. A subquery
  // evaluates timestamp(raw) at each historical step, not today's computed time.
  const latest = aggregate('max', [
    [cpu, valid(cpu), 'cpu'],
    [available, valid(available), 'memoryAvailable'],
    [total, valid(total, true), 'memoryTotal'],
    [free, valid(free), 'diskFree'],
    [size, valid(size, true), 'diskSize'],
    [rx, valid(rx), 'networkRx'],
    [tx, valid(tx), 'networkTx'],
    [boot, bootValid, 'uptimeHours'],
  ].map(([q, eligible, name]) => mark(rawTime(q!, eligible!), name!, '__ops_source')).join(' or '));
  return {
    values,
    current: Object.entries(values).map(([name, q]) => mark(q, name)).join(' or '),
    source: [...Object.entries(sources).map(([name, q]) => mark(q, name)), mark(latest, 'heartbeat')].join(' or '),
    lastSeen: mark(aggregate('max', `max_over_time((${latest})[7d:60s])`), 'heartbeat'),
  };
}
