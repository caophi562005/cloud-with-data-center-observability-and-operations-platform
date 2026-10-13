import { BadRequestException } from '@nestjs/common';
import { finiteNonnegative, escapeMetricRegex } from '../vm-metrics.telegraf-contract.js';
import { getNativeIntegrationProfile } from './integration-metric-profiles.js';
import type { IntegrationKind } from './monitoring.types.js';
import type { IntegrationMetricDefinition, IntegrationQueryContext } from './integration-metrics.types.js';

export const INTEGRATION_METRICS_REVISION = 'integration-metrics-v1';
export const INTEGRATION_FRESH_SECONDS = 300;
export const INTEGRATION_RANGE_SECONDS = { '15m': 900, '1h': 3600, '6h': 21600, '24h': 86400 } as const;
export const INTEGRATION_METRIC_LABEL = '__ops_integration_metric';
type Grouping = 'global' | 'db' | 'database' | 'container';
type Formula = 'raw' | 'rate' | 'fraction' | 'sum-fraction' | 'complement';
export type MetricDescriptor = IntegrationMetricDefinition & {
  grouping: Grouping; inputs: readonly string[]; formula: Formula; os?: 'linux' | 'windows';
};
function raw(key: string, label: string, group: string, unit: string, semanticType: 'gauge' | 'counter' = 'gauge',
  grouping: Grouping = 'global', description = 'Native Telegraf value; sample presence is not service health.'): MetricDescriptor {
  return { key, label, group, unit, semanticType, grouping, description, chart: true, inputs: [key], formula: 'raw' };
}
function rate(key: string, label: string, input: string, group: string, unit = 'count/s', grouping: Grouping = 'global'): MetricDescriptor {
  return { key, label, group, unit, semanticType: 'rate', grouping, chart: true, inputs: [input], formula: 'rate',
    description: 'Reset-aware rate over 5 minutes; fewer than two samples yields no value.' };
}
function ratio(key: string, label: string, inputs: string[], formula: Formula, group: string,
  grouping: Grouping = 'global', description = 'Fresh same-entity operands; denominator must be positive.'): MetricDescriptor {
  return { key, label, group, unit: 'percent', semanticType: 'ratio', grouping, description, chart: true, inputs, formula };
}
const descriptors: Record<IntegrationKind, readonly MetricDescriptor[]> = {
  redis: [
    raw('redis_clients', 'Connected clients', 'Clients', 'count'),
    raw('redis_blocked_clients', 'Blocked clients', 'Clients', 'count'),
    raw('redis_used_memory', 'Used memory', 'Memory', 'bytes'), raw('redis_maxmemory', 'Configured maxmemory', 'Memory', 'bytes'),
    raw('redis_uptime', 'Uptime', 'Activity', 'seconds'),
    raw('redis_total_commands_processed', 'Commands', 'Activity', 'count', 'counter'),
    raw('redis_keyspace_hits', 'Keyspace hits', 'Cache', 'count', 'counter'),
    raw('redis_keyspace_misses', 'Keyspace misses', 'Cache', 'count', 'counter'),
    raw('redis_evicted_keys', 'Evicted keys', 'Cache', 'count', 'counter'),
    raw('redis_expired_keys', 'Expired keys', 'Cache', 'count', 'counter'),
    raw('redis_keyspace_keys', 'Keys', 'Keyspace', 'count', 'gauge', 'database'),
    raw('redis_keyspace_expires', 'Expiring keys', 'Keyspace', 'count', 'gauge', 'database'),
    raw('redis_keyspace_avg_ttl', 'Average TTL', 'Keyspace', 'milliseconds', 'gauge', 'database'),
    rate('redis_commands_per_second', 'Commands per second', 'redis_total_commands_processed', 'Activity'),
    rate('redis_evictions_per_second', 'Evictions per second', 'redis_evicted_keys', 'Cache'),
    rate('redis_expirations_per_second', 'Expirations per second', 'redis_expired_keys', 'Cache'),
    ratio('redis_cache_hit_percent', 'Cache hit ratio', ['redis_keyspace_hits', 'redis_keyspace_misses'], 'sum-fraction', 'Cache'),
    ratio('redis_memory_used_percent', 'Configured memory used', ['redis_used_memory', 'redis_maxmemory'], 'fraction', 'Memory'),
  ],
  postgresql: [
    raw('postgresql_numbackends', 'Connections', 'Connections', 'count', 'gauge', 'db'),
    ...(['xact_commit', 'xact_rollback', 'blks_read', 'blks_hit', 'tup_returned', 'tup_fetched', 'tup_inserted', 'tup_updated', 'tup_deleted', 'deadlocks'] as const)
      .map((field) => raw(`postgresql_${field}`, field.replaceAll('_', ' '), 'Database', 'count', 'counter', 'db')),
    raw('postgresql_temp_bytes', 'Temporary bytes', 'Database', 'bytes', 'counter', 'db'),
    rate('postgresql_commits_per_second', 'Commits per second', 'postgresql_xact_commit', 'Transactions', 'count/s', 'db'),
    rate('postgresql_rollbacks_per_second', 'Rollbacks per second', 'postgresql_xact_rollback', 'Transactions', 'count/s', 'db'),
    rate('postgresql_tuples_returned_per_second', 'Tuples returned per second', 'postgresql_tup_returned', 'Tuples', 'count/s', 'db'),
    rate('postgresql_tuples_fetched_per_second', 'Tuples fetched per second', 'postgresql_tup_fetched', 'Tuples', 'count/s', 'db'),
    rate('postgresql_tuples_inserted_per_second', 'Tuples inserted per second', 'postgresql_tup_inserted', 'Tuples', 'count/s', 'db'),
    rate('postgresql_tuples_updated_per_second', 'Tuples updated per second', 'postgresql_tup_updated', 'Tuples', 'count/s', 'db'),
    rate('postgresql_tuples_deleted_per_second', 'Tuples deleted per second', 'postgresql_tup_deleted', 'Tuples', 'count/s', 'db'),
    ratio('postgresql_cache_hit_percent', 'Block cache hit ratio', ['postgresql_blks_hit', 'postgresql_blks_read'], 'sum-fraction', 'Cache', 'db'),
  ],
  mysql: [
    raw('mysql_threads_connected', 'Connected threads', 'Threads', 'count'), raw('mysql_threads_running', 'Running threads', 'Threads', 'count'),
    raw('mysql_uptime', 'Uptime', 'Activity', 'seconds'),
    ...(['questions', 'slow_queries', 'aborted_connects', 'innodb_buffer_pool_reads', 'innodb_buffer_pool_read_requests', 'innodb_row_lock_waits'] as const)
      .map((field) => raw(`mysql_${field}`, field.replaceAll('_', ' '), 'Global status', 'count', 'counter')),
    raw('mysql_bytes_received', 'Bytes received', 'Network', 'bytes', 'counter'), raw('mysql_bytes_sent', 'Bytes sent', 'Network', 'bytes', 'counter'),
    raw('mysql_innodb_row_lock_time', 'Row lock time', 'Locks', 'milliseconds', 'counter'),
    rate('mysql_questions_per_second', 'Questions per second', 'mysql_questions', 'Activity'),
    rate('mysql_slow_queries_per_second', 'Slow queries per second', 'mysql_slow_queries', 'Activity'),
    rate('mysql_aborted_connects_per_second', 'Aborted connects per second', 'mysql_aborted_connects', 'Connections'),
    rate('mysql_bytes_received_per_second', 'Receive throughput', 'mysql_bytes_received', 'Network', 'bytes/s'),
    rate('mysql_bytes_sent_per_second', 'Send throughput', 'mysql_bytes_sent', 'Network', 'bytes/s'),
    ratio('mysql_buffer_hit_percent', 'Buffer pool hit ratio', ['mysql_innodb_buffer_pool_reads', 'mysql_innodb_buffer_pool_read_requests'], 'complement', 'Cache'),
  ],
  nginx: [
    ...(['active', 'reading', 'writing', 'waiting'] as const).map((field) => raw(`nginx_${field}`, `${field} connections`, 'Connections', 'count')),
    ...(['accepts', 'handled', 'requests'] as const).map((field) => raw(`nginx_${field}`, field, 'Activity', 'count', 'counter')),
    rate('nginx_requests_per_second', 'Requests per second', 'nginx_requests', 'Activity'),
    rate('nginx_accepts_per_second', 'Accepted connections per second', 'nginx_accepts', 'Connections'),
    rate('nginx_handled_per_second', 'Handled connections per second', 'nginx_handled', 'Connections'),
  ],
  docker: [
    ...(['running', 'paused', 'stopped'] as const).map((state) => raw(`docker_n_containers_${state}`, `${state} containers (daemon-wide)`, 'Engine', 'count')),
    raw('docker_container_cpu_usage_percent', 'CPU usage', 'Container CPU', 'percent', 'gauge', 'container', 'Native total CPU; multicore Linux values may exceed 100%.'),
    raw('docker_container_cpu_usage_total', 'Cumulative CPU usage', 'Container CPU', 'nanoseconds', 'counter', 'container'),
    { ...raw('docker_container_mem_usage', 'Accounted memory usage', 'Container memory', 'bytes', 'gauge', 'container'), os: 'linux' },
    { ...raw('docker_container_mem_limit', 'Daemon-reported memory limit', 'Container memory', 'bytes', 'gauge', 'container', 'Not evidence of a configured container hard cap; may reflect host RAM.'), os: 'linux' },
    { ...ratio('docker_container_mem_usage_percent', 'Reported memory accounting percentage', ['docker_container_mem_usage', 'docker_container_mem_limit'], 'fraction', 'Container memory', 'container', 'Usage / daemon-reported positive limit; not a proven configured hard-cap budget.'), os: 'linux' },
    ...(['commit_bytes', 'commit_peak_bytes', 'private_working_set'] as const).map((field) => ({
      ...raw(`docker_container_mem_${field}`, field.replaceAll('_', ' '), 'Container memory', 'bytes', 'gauge', 'container', 'Windows memory accounting; not Linux usage/limit.'), os: 'windows' as const,
    })),
    raw('docker_container_net_rx_bytes', 'Received bytes', 'Container network', 'bytes', 'counter', 'container'),
    raw('docker_container_net_tx_bytes', 'Sent bytes', 'Container network', 'bytes', 'counter', 'container'),
    raw('docker_container_status_restart_count', 'Restart count', 'Container lifecycle', 'count', 'counter', 'container'),
    raw('docker_container_status_exitcode', 'Last exit code', 'Container lifecycle', 'count', 'gauge', 'container', 'Latest reported sample, not proof of current container state or service health.'),
    raw('docker_container_blkio_io_service_bytes_recursive_read', 'Block I/O read bytes', 'Container block I/O', 'bytes', 'counter', 'container', 'Optional native cgroup counter; missing input is unavailable, not zero.'),
    raw('docker_container_blkio_io_service_bytes_recursive_write', 'Block I/O write bytes', 'Container block I/O', 'bytes', 'counter', 'container', 'Optional native cgroup counter; missing input is unavailable, not zero.'),
    rate('docker_container_net_rx_bytes_per_second', 'Receive throughput', 'docker_container_net_rx_bytes', 'Container network', 'bytes/s', 'container'),
    rate('docker_container_net_tx_bytes_per_second', 'Send throughput', 'docker_container_net_tx_bytes', 'Container network', 'bytes/s', 'container'),
    rate('docker_container_blkio_read_bytes_per_second', 'Block read throughput', 'docker_container_blkio_io_service_bytes_recursive_read', 'Container block I/O', 'bytes/s', 'container'),
    rate('docker_container_blkio_write_bytes_per_second', 'Block write throughput', 'docker_container_blkio_io_service_bytes_recursive_write', 'Container block I/O', 'bytes/s', 'container'),
  ],
};

export function integrationMetricDescriptors(context: IntegrationQueryContext): MetricDescriptor[] {
  return descriptors[context.instance.kind].filter((metric) => !metric.os || !context.os || metric.os === context.os)
    .map((metric) => metric.key === 'docker_container_cpu_usage_total' && context.os === 'windows'
      ? { ...metric, unit: '100ns', description: 'Windows cumulative CPU in native 100-nanosecond units, not Linux nanoseconds.' } : { ...metric });
}
export function publicIntegrationMetricDefinitions(context: IntegrationQueryContext): IntegrationMetricDefinition[] {
  return integrationMetricDescriptors(context).map(({ key, label, group, unit, semanticType, description, chart }) =>
    ({ key, label, group, unit, semanticType, description, chart }));
}
export function getIntegrationMetric(context: IntegrationQueryContext, key: string): MetricDescriptor {
  const metric = integrationMetricDescriptors(context).find((descriptor) => descriptor.key === key);
  if (!metric) throw new BadRequestException('Invalid integration metric');
  return metric;
}
export function validateIntegrationEntity(context: IntegrationQueryContext, metric: MetricDescriptor, entityKey: string | null): void {
  if (entityKey === null) return; // Current enumeration; range restricts multi-entity descriptors separately.
  const instance = context.instance;
  const valid = metric.grouping === 'db' && instance.kind === 'postgresql' ? entityKey === `db:${instance.settings.database}`
    : metric.grouping === 'database' ? /^database:db[0-9]{1,10}$/.test(entityKey)
    : metric.grouping === 'container' && instance.kind === 'docker' ? /^container:[0-9a-f]{12}:[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(entityKey) &&
      (instance.settings.containerNames ?? []).includes(entityKey.slice(23)) : false;
  if (!valid) throw new BadRequestException('Invalid integration entity');
}
export function integrationMetricUnavailable(context: IntegrationQueryContext, metric: MetricDescriptor): string | null {
  if (metric.os && metric.os !== context.os) return 'Metric is not supported on this operating system';
  if (metric.grouping === 'container' && context.instance.kind === 'docker' && !context.instance.settings.collectContainerMetrics)
    return 'Container metrics collection is not enabled';
  return null;
}
export function integrationEntityFromLabels(context: IntegrationQueryContext, metric: MetricDescriptor, labels: Record<string, string>): string | null | undefined {
  const identity = context.identity;
  if (!identity || labels.organization_id !== identity.organizationId || labels.vm_id !== identity.vmId ||
    labels.agent_id !== identity.agentId || labels.integration_instance_id !== context.instance.id) return undefined;
  const extras = metric.grouping === 'db' ? ['db'] : metric.grouping === 'database' ? ['database'] : metric.grouping === 'container' ? ['source', 'container_name'] : [];
  const allowed = new Set(['organization_id', 'vm_id', 'agent_id', 'integration_instance_id', INTEGRATION_METRIC_LABEL, ...extras]);
  if (Object.keys(labels).some((key) => !allowed.has(key))) return undefined;
  const entity = metric.grouping === 'global' ? null : metric.grouping === 'db' ? `db:${labels.db}`
    : metric.grouping === 'database' ? `database:${labels.database}` : `container:${labels.source}:${labels.container_name}`;
  try { validateIntegrationEntity(context, metric, entity); return entity; } catch { return undefined; }
}

export function buildIntegrationMetricExpression(context: IntegrationQueryContext, metricKey: string, entityKey: string | null, mode: 'value' | 'timestamp'): string {
  if (!context.compatible || !context.identity || !context.os) throw new BadRequestException('Unsupported integration context');
  const metric = getIntegrationMetric(context, metricKey);
  validateIntegrationEntity(context, metric, entityKey);
  if (integrationMetricUnavailable(context, metric)) throw new BadRequestException('Unavailable integration metric');
  const identity = context.identity;
  const labels = [`organization_id=${JSON.stringify(identity.organizationId)}`, `vm_id=${JSON.stringify(identity.vmId)}`,
    `agent_id=${JSON.stringify(identity.agentId)}`, `integration_instance_id=${JSON.stringify(context.instance.id)}`];
  let group = 'organization_id,vm_id,agent_id,integration_instance_id';
  if (metric.grouping === 'db' && context.instance.kind === 'postgresql') {
    labels.push(`db=${JSON.stringify(context.instance.settings.database)}`); group += ',db';
  } else if (metric.grouping === 'database') {
    labels.push(entityKey ? `database=${JSON.stringify(entityKey.slice(9))}` : 'database=~"db[0-9]{1,10}"'); group += ',database';
  } else if (metric.grouping === 'container' && context.instance.kind === 'docker') {
    labels.push(entityKey ? `source=${JSON.stringify(entityKey.slice(10, 22))}` : 'source=~"[0-9a-f]{12}"',
      entityKey ? `container_name=${JSON.stringify(entityKey.slice(23))}` :
        `container_name=~${JSON.stringify((context.instance.settings.containerNames ?? []).map(escapeMetricRegex).join('|'))}`);
    group += ',source,container_name';
  }
  const profile = getNativeIntegrationProfile(context.instance, context.os);
  const raws = metric.inputs.map((name) => {
    // Redis redis_keyspace_hits belongs to redis/keyspace_hits, not redis_keyspace/hits.
    // Match the whole reviewed measurement+field pair, not just the longest prefix.
    const measurement = [...profile.measurements].sort((a, b) => b.length - a.length).find((prefix) =>
      name.startsWith(`${prefix}_`) && profile.fields.includes(name.slice(prefix.length + 1)));
    if (!measurement) throw new BadRequestException('Invalid native metric');
    const totals = measurement === 'docker_container_cpu' ? ',cpu="cpu-total"' : measurement === 'docker_container_net' ? ',network="total"'
      : measurement === 'docker_container_blkio' ? ',device="total"' : '';
    return `${name}{${labels.join(',')}${totals}}`;
  });
  const aggregate = (value: string) => `max by (${group}) (${value})`;
  const eligible = (raw: string) => `(${finiteNonnegative(raw)} and (timestamp(${raw}) <= time()))`;
  const fresh = (raw: string) => `(${eligible(raw)} and (time() - timestamp(${raw}) <= ${INTEGRATION_FRESH_SECONDS}))`;
  if (mode === 'timestamp') {
    // timestamp is applied to EACH raw selector BEFORE grouping, math, OR or marker labels.
    const times = raws.map((raw) => aggregate(`timestamp(${raw}) and ${eligible(raw)}`));
    return times.reduce((left, right) => `((${left}) + (${right}) - abs((${left}) - (${right}))) / 2`);
  }
  const values = raws.map((raw) => aggregate(fresh(raw)));
  if (metric.formula === 'raw') return values[0];
  if (metric.formula === 'rate') {
    const raw = raws[0];
    return aggregate(`(${finiteNonnegative(`rate(${raw}[5m])`)} and ${fresh(raw)} and (min_over_time(${raw}[5m]) >= 0) and (count_over_time(${raw}[5m]) >= 2))`);
  }
  const [a, b] = values;
  const denominator = metric.formula === 'sum-fraction' ? `((${a}) + (${b}))` : `(${b})`;
  const fraction = `((${a}) / (${denominator} > 0))`;
  return metric.formula === 'complement' ? `(1 - (${fraction} <= 1)) * 100` : `${fraction} * 100`;
}
