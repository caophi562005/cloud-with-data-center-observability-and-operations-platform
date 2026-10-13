import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'smol-toml';
import { getMonitoringCatalog } from './integration-catalog.js';
import { getNativeIntegrationProfile } from './integration-metric-profiles.js';
import { AGENT_CREDENTIAL_MARKER, AGENT_ID_MARKER, renderMonitoringConfig } from './integration-renderer.js';
import { parseMonitoringDefinition, validateMonitoringDefinition } from './monitoring.schema.js';
import type { IntegrationInstance, MonitoringDefinition } from './monitoring.types.js';

const id = '44444444-4444-4444-8444-444444444444';
const docker: IntegrationInstance = {
  id, kind: 'docker', enabled: true, intervalSeconds: 30,
  settings: { endpoint: 'unix:///var/run/docker.sock', acknowledgePrivilegedAccess: true },
};
const selected: IntegrationInstance = {
  ...docker, settings: { ...docker.settings, collectContainerMetrics: true, containerNames: ['opsgrid-e2e-redis-a'] },
};
function definition(...integrations: IntegrationInstance[]): MonitoringDefinition {
  return { schemaVersion: 1, profileKey: 'telegraf-native-v1', host: { intervalSeconds: 3600 }, integrations };
}
function withDockerSettings(settings: Record<string, unknown>): unknown {
  return { ...definition(), integrations: [{ ...docker, settings: { ...docker.settings, ...settings } }] };
}
const context = { os: 'linux', apiOrigin: 'https://api.example.test',
  metricsWriteUrl: 'https://metrics.example.test/write' } as const;
function render(value: MonitoringDefinition) {
  vi.stubEnv('AGENT_MONITORING_SECRET_KEY', '11'.repeat(32));
  return renderMonitoringConfig(value, {}, context);
}
// Real renderer/encoder output; no native runtime, network, database or mocked production behavior.
type NativeBlock = Record<string, unknown>;
function document(toml: string) {
  return parse(toml) as unknown as {
    agent: NativeBlock; inputs: Record<string, NativeBlock[]>; outputs: Record<string, NativeBlock[]>;
  };
}
afterEach(() => vi.unstubAllEnvs());

describe('native integration profile contracts', () => {
  it('defaults old Docker JSON to engine-only and retains disabled selections without collecting them', () => {
    const parsed = parseMonitoringDefinition(definition(docker));
    expect(parsed.integrations[0].settings).toMatchObject({ collectContainerMetrics: false, containerNames: [] });
    const profile = getNativeIntegrationProfile(parsed.integrations[0], 'linux');
    expect(profile.measurements).toEqual(['docker']);
    expect(profile.fields).toEqual(['n_containers_running', 'n_containers_paused', 'n_containers_stopped']);
    expect(profile.options).toEqual({ container_name_include: [], container_name_exclude: ['*'], source_tag: false });
    const retained = parseMonitoringDefinition(withDockerSettings({ collectContainerMetrics: false, containerNames: ['kept'] }));
    expect(retained.integrations[0].settings).toMatchObject({ containerNames: ['kept'] });
    expect(document(render(retained).toml).inputs.docker[0]).toMatchObject({
      namepass: ['docker'], container_name_include: [], container_name_exclude: ['*'], source_tag: false,
    });
  });

  it('rejects empty enabled selection, wildcards, duplicates, invalid/oversized names and oversized lists without normalization', () => {
    const invalidLists = [[], ['*'], ['redis?'], [' redis'], ['redis '], ['/redis'], [''], ['-redis'],
      ['redis', 'redis'], ['a'.repeat(129)], Array.from({ length: 33 }, (_, index) => `redis-${index}`)];
    for (const containerNames of invalidLists) {
      expect(() => parseMonitoringDefinition(withDockerSettings({ collectContainerMetrics: true, containerNames }))).toThrow();
    }
    for (const containerNames of [['*'], ['same', 'same'], Array.from({ length: 33 }, (_, index) => `c${index}`)]) {
      expect(() => parseMonitoringDefinition(withDockerSettings({ collectContainerMetrics: false, containerNames }))).toThrow();
    }
    const names = ['Redis_1', 'redis.2', ...Array.from({ length: 30 }, (_, index) => `r-${index}`)];
    const parsed = parseMonitoringDefinition(withDockerSettings({ collectContainerMetrics: true, containerNames: names }));
    expect(parsed.integrations[0].settings).toMatchObject({ containerNames: names });
    expect(() => parseMonitoringDefinition(withDockerSettings({ containerNames: ['a'.repeat(128)] }))).not.toThrow();
  });

  it('preserves exact enabled Docker selectors and lifecycle/total dimensions without invented native options', () => {
    const profile = getNativeIntegrationProfile(selected, 'linux');
    expect(profile.options.container_name_include).toEqual(['opsgrid-e2e-redis-a']);
    expect(profile.options.container_name_exclude).toEqual([]);
    expect(profile.options.source_tag).toBe(true);
    expect(profile.measurements).toEqual(['docker', 'docker_container_cpu', 'docker_container_mem',
      'docker_container_net', 'docker_container_status', 'docker_container_blkio']);
    expect(profile.tags).toEqual(['integration_instance_id', 'container_name', 'source', 'cpu', 'network', 'device']);
    const block = document(render(definition(selected)).toml).inputs.docker[0];
    expect(block).toMatchObject({ namepass: [...profile.measurements], fieldpass: [...profile.fields],
      taginclude: [...profile.tags], ...profile.options, tags: { integration_instance_id: id } });
    for (const key of ['gather_container_stats', 'container_state_include', 'perdevice_include', 'total_include']) {
      expect(block).not.toHaveProperty(key);
    }
    (profile.options.container_name_include as string[]).push('not-shared');
    expect(selected.settings).toMatchObject({ containerNames: ['opsgrid-e2e-redis-a'] });
  });

  it('uses OS-aware Docker memory filters while preserving CPU and cumulative I/O fields', () => {
    const linux = getNativeIntegrationProfile(selected, 'linux');
    const windows = getNativeIntegrationProfile(selected, 'windows');
    expect(linux.fields).toEqual(expect.arrayContaining(['usage', 'limit', 'usage_percent']));
    expect(windows.fields).toEqual(expect.arrayContaining(['commit_bytes', 'commit_peak_bytes', 'private_working_set']));
    expect(windows.fields).not.toContain('usage');
    expect(windows.fields).not.toContain('limit');
    expect(linux.fields).not.toContain('commit_bytes');
    for (const profile of [linux, windows]) {
      expect(profile.fields).toEqual(expect.arrayContaining(['usage_total', 'rx_bytes', 'tx_bytes', 'restart_count', 'exitcode',
        'io_service_bytes_recursive_read', 'io_service_bytes_recursive_write']));
      expect(profile.fields.some((field) => field.endsWith('_total') && field !== 'usage_total')).toBe(false);
    }
    const windowsInstance: IntegrationInstance = { ...selected, settings: { ...selected.settings, endpoint: 'npipe:////./pipe/docker_engine' } };
    vi.stubEnv('AGENT_MONITORING_SECRET_KEY', '11'.repeat(32));
    const rendered = renderMonitoringConfig(definition(windowsInstance), {}, { ...context, os: 'windows' });
    expect(document(rendered.toml).inputs.docker[0].fieldpass).toEqual([...windows.fields]);
  });

  it('renders Redis keyspace, PostgreSQL DB and exact MySQL/Nginx native field allowlists', () => {
    const services: IntegrationInstance[] = [
      { id, kind: 'redis', enabled: true, intervalSeconds: 30, settings: { host: 'localhost', port: 6379, tls: false } },
      { id: '55555555-5555-4555-8555-555555555555', kind: 'postgresql', enabled: true, intervalSeconds: 30,
        settings: { host: 'localhost', port: 5432, database: 'ops', sslMode: 'disable' } },
      { id: '66666666-6666-4666-8666-666666666666', kind: 'mysql', enabled: true, intervalSeconds: 30,
        settings: { host: 'localhost', port: 3306, tls: false } },
      { id: '77777777-7777-4777-8777-777777777777', kind: 'nginx', enabled: true, intervalSeconds: 30,
        settings: { statusUrl: 'http://localhost/status', tls: false } },
    ];
    const inputs = document(render(definition(...services)).toml).inputs;
    expect(inputs.redis[0]).toMatchObject({ namepass: ['redis', 'redis_keyspace'], taginclude: ['integration_instance_id', 'database'],
      fieldpass: ['clients', 'blocked_clients', 'used_memory', 'maxmemory', 'uptime', 'total_commands_processed',
        'keyspace_hits', 'keyspace_misses', 'evicted_keys', 'expired_keys', 'keys', 'expires', 'avg_ttl'] });
    expect(inputs.postgresql[0]).toMatchObject({ databases: ['ops'], taginclude: ['integration_instance_id', 'db'],
      fieldpass: ['numbackends', 'xact_commit', 'xact_rollback', 'blks_read', 'blks_hit', 'tup_returned', 'tup_fetched',
        'tup_inserted', 'tup_updated', 'tup_deleted', 'temp_bytes', 'deadlocks'] });
    expect(inputs.mysql[0]).toMatchObject({ metric_version: 2, taginclude: ['integration_instance_id'],
      fieldpass: ['threads_connected', 'threads_running', 'uptime', 'questions', 'slow_queries', 'aborted_connects',
        'bytes_received', 'bytes_sent', 'innodb_buffer_pool_reads', 'innodb_buffer_pool_read_requests',
        'innodb_row_lock_waits', 'innodb_row_lock_time'] });
    expect(Object.entries(inputs.mysql[0]).filter(([key]) => key.startsWith('gather_')).every(([, value]) => value === false)).toBe(true);
    expect(inputs.nginx[0].fieldpass).toEqual(['active', 'reading', 'writing', 'waiting', 'accepts', 'handled', 'requests']);
    expect(getMonitoringCatalog().integrations.find((entry) => entry.kind === 'redis')?.measurements).toContain('redis_keyspace');
    expect(render(definition(...services)).hash).toBe(render(definition(...services.toReversed())).hash);
  });

  it('structurally parses without OS/secrets while preserving strict bounds, duplicate IDs and OS-specific validation', () => {
    const windows: IntegrationInstance = { ...docker, settings: { ...docker.settings, endpoint: 'npipe:////./pipe/docker_engine' } };
    expect(parseMonitoringDefinition(definition(windows)).integrations).toHaveLength(1);
    expect(() => validateMonitoringDefinition(definition(windows), 'linux')).toThrow();
    expect(() => validateMonitoringDefinition(definition(docker), 'windows')).toThrow();
    expect(() => parseMonitoringDefinition(definition(docker, docker))).toThrow();
    expect(() => parseMonitoringDefinition({ ...definition(docker), extra: true })).toThrow();
    expect(() => parseMonitoringDefinition(withDockerSettings({ endpoint: 'tcp://localhost:2375' }))).toThrow();
    expect(() => parseMonitoringDefinition(JSON.parse('{"constructor":{}}'))).toThrow();
    expect(() => parseMonitoringDefinition({ ...definition(), extra: 'x'.repeat(256 * 1024) })).toThrow();
    const tls: IntegrationInstance = { id, kind: 'redis', enabled: true, intervalSeconds: 30,
      settings: { host: 'localhost', port: 6379, tls: true, tlsCaPath: 'C:\\certs\\ca.pem' } };
    expect(() => parseMonitoringDefinition(definition(tls))).not.toThrow();
    expect(() => validateMonitoringDefinition(definition(tls), 'linux')).toThrow();
    expect(() => validateMonitoringDefinition(definition(tls), 'windows')).not.toThrow();
  });

  it('keeps host/internal cadence, protected outputs, canonical hash and disabled-instance behavior', () => {
    const result = render(definition(selected));
    const doc = document(result.toml);
    expect(doc.agent.interval).toBe('3600s');
    expect(doc.inputs.system[0]).toMatchObject({ include: ['load', 'uptime'], interval: '3600s' });
    expect(doc.inputs.internal[0]).toMatchObject({ interval: '60s', namepass: ['internal_agent'], fieldpass: ['metrics_gathered'] });
    expect(doc.inputs.cpu[0]).toMatchObject({ interval: '3600s', fieldpass: ['usage_idle'] });
    expect(doc.outputs.http[0]).toMatchObject({ url: context.metricsWriteUrl, data_format: 'prometheusremotewrite',
      prometheus_string_as_label: false, headers: { Authorization: `Bearer ${AGENT_CREDENTIAL_MARKER}`,
        'Content-Encoding': 'snappy', 'X-Prometheus-Remote-Write-Version': '0.1.0' } });
    expect(doc.outputs.heartbeat[0]).toMatchObject({ interval: '60s', instance_id: AGENT_ID_MARKER,
      token: AGENT_CREDENTIAL_MARKER, url: `${context.apiOrigin}/api/v1/agent/heartbeat` });
    expect(result).toMatchObject({ schemaVersion: 1, profileKey: 'telegraf-native-v1' });
    expect(result.byteLength).toBe(Buffer.byteLength(result.toml, 'utf8'));
    expect(result.byteLength).toBeLessThan(256 * 1024);
    expect(render(definition({ ...selected, enabled: false })).toml).not.toContain('[[inputs.docker]]');
    expect(result.hash).not.toBe(render(definition(docker)).hash);
    expect(() => renderMonitoringConfig(definition(selected), {}, { ...context, metricsWriteUrl: 'http://unsafe.test/write' })).toThrow();
  });
});
