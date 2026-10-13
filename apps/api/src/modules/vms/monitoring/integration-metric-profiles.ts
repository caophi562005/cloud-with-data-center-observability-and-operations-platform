import type { IntegrationInstance, IntegrationKind, SupportedAgentOs } from './monitoring.types.js';

export type NativeIntegrationProfile = {
  measurements: readonly string[];
  fields: readonly string[];
  tags: readonly string[];
  options: Record<string, string | number | boolean | string[]>;
};

type NativeFilters = Pick<NativeIntegrationProfile, 'measurements' | 'fields' | 'tags'>;
const dockerEngineFields = ['n_containers_running', 'n_containers_paused', 'n_containers_stopped'] as const;
const dockerStatsFields = [
  'usage_percent', 'usage_total', 'rx_bytes', 'tx_bytes', 'restart_count', 'exitcode',
  'io_service_bytes_recursive_read', 'io_service_bytes_recursive_write',
] as const;
const dockerMemoryFields = {
  linux: ['usage', 'limit', 'usage_percent'],
  windows: ['commit_bytes', 'commit_peak_bytes', 'private_working_set'],
} as const;

// Source-derived Telegraf 1.40.1 (26b8f4478b676f4f5e5d8ce1622cdf4f6c273bda).
// These are native fields, not serialized metric names or runtime-verified availability.
// Catalog advertises the full supported filter set; rendering selects Docker opt-in/OS below.
export const NATIVE_INTEGRATION_FILTERS = {
  redis: {
    measurements: ['redis', 'redis_keyspace'],
    fields: ['clients', 'blocked_clients', 'used_memory', 'maxmemory', 'uptime',
      'total_commands_processed', 'keyspace_hits', 'keyspace_misses', 'evicted_keys', 'expired_keys',
      'keys', 'expires', 'avg_ttl'],
    tags: ['integration_instance_id', 'database'],
  },
  postgresql: {
    measurements: ['postgresql'],
    fields: ['numbackends', 'xact_commit', 'xact_rollback', 'blks_read', 'blks_hit',
      'tup_returned', 'tup_fetched', 'tup_inserted', 'tup_updated', 'tup_deleted', 'temp_bytes', 'deadlocks'],
    tags: ['integration_instance_id', 'db'],
  },
  mysql: {
    measurements: ['mysql'],
    fields: ['threads_connected', 'threads_running', 'uptime', 'questions', 'slow_queries',
      'aborted_connects', 'bytes_received', 'bytes_sent', 'innodb_buffer_pool_reads',
      'innodb_buffer_pool_read_requests', 'innodb_row_lock_waits', 'innodb_row_lock_time'],
    tags: ['integration_instance_id'],
  },
  nginx: {
    measurements: ['nginx'],
    fields: ['active', 'reading', 'writing', 'waiting', 'accepts', 'handled', 'requests'],
    tags: ['integration_instance_id'],
  },
  docker: {
    measurements: ['docker', 'docker_container_cpu', 'docker_container_mem', 'docker_container_net',
      'docker_container_status', 'docker_container_blkio'],
    fields: [...dockerEngineFields, ...dockerStatsFields, ...dockerMemoryFields.linux,
      ...dockerMemoryFields.windows].filter((field, index, fields) => fields.indexOf(field) === index),
    tags: ['integration_instance_id', 'container_name', 'source', 'cpu', 'network', 'device'],
  },
} as const satisfies Record<IntegrationKind, NativeFilters>;

export function getNativeIntegrationProfile(instance: IntegrationInstance, os: SupportedAgentOs): NativeIntegrationProfile {
  const filters = NATIVE_INTEGRATION_FILTERS[instance.kind];
  if (instance.kind !== 'docker') return { ...filters, options: {} };
  const collect = instance.settings.collectContainerMetrics ?? false;
  // Native empty include means ALL containers: disabled always excludes '*'.
  // Native defaults already select running state, per-device cpu and cpu/blkio/network totals.
  return {
    measurements: collect ? filters.measurements : ['docker'],
    fields: collect ? [...new Set([...dockerEngineFields, ...dockerStatsFields, ...dockerMemoryFields[os]])]
      : dockerEngineFields,
    tags: collect ? filters.tags : ['integration_instance_id'],
    options: {
      container_name_include: collect ? [...(instance.settings.containerNames ?? [])] : [],
      container_name_exclude: collect ? [] : ['*'],
      source_tag: collect,
    },
  };
}
