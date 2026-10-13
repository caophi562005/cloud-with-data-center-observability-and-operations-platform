import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA, HEADERS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MetricsQueryClient } from '../../../infrastructure/metrics/metrics-query.client.js';
import type { MetricMatrix, MetricVector } from '../../../infrastructure/metrics/metrics.types.js';
import {
  buildIntegrationMetricExpression, integrationEntityFromLabels, integrationMetricDescriptors, publicIntegrationMetricDefinitions,
  INTEGRATION_METRIC_LABEL,
} from './integration-metrics.contract.js';
import { IntegrationMetricsController } from './integration-metrics.controller.js';
import { integrationMetricsCurrentSchema, integrationMetricsParamsSchema, integrationMetricsRangeSchema } from './integration-metrics.schema.js';
import { IntegrationMetricsService } from './integration-metrics.service.js';
import type { IntegrationQueryContext } from './integration-metrics.types.js';
import { IntegrationObservationService } from './integration-observation.service.js';
import type { MonitoringRepository, MonitoringSnapshot } from './monitoring.repository.js';
import type { IntegrationInstance, IntegrationObservation } from './monitoring.types.js';

const organizationId = '11111111-1111-4111-8111-111111111111';
const vmId = '22222222-2222-4222-8222-222222222222';
const agentId = '33333333-3333-4333-8333-333333333333';
const instanceId = '44444444-4444-4444-8444-444444444444';
const otherId = '55555555-5555-4555-8555-555555555555';
const identity = { organizationId, vmId, agentId };
const now = 1800000000;
const redis: IntegrationInstance = { id: instanceId, kind: 'redis', enabled: true, intervalSeconds: 30,
  settings: { host: '127.0.0.1', port: 6379, tls: false } };
const pg: IntegrationInstance = { id: instanceId, kind: 'postgresql', enabled: true, intervalSeconds: 30,
  settings: { host: '127.0.0.1', port: 5432, database: 'app', sslMode: 'disable' } };
const docker: IntegrationInstance = { id: instanceId, kind: 'docker', enabled: true, intervalSeconds: 30,
  settings: { endpoint: 'unix:///var/run/docker.sock', acknowledgePrivilegedAccess: true,
    collectContainerMetrics: true, containerNames: ['redis-a', 'redis.b'] } };
function context(instance: IntegrationInstance = redis): IntegrationQueryContext {
  return { identity, os: 'linux', compatible: true, instance };
}
function labels(metric: string, extra: Record<string, string> = {}) {
  return { organization_id: organizationId, vm_id: vmId, agent_id: agentId, integration_instance_id: instanceId,
    [INTEGRATION_METRIC_LABEL]: metric, ...extra };
}
function vector(metric: string, value: number | null, extra: Record<string, string> = {}, timestamp = now): MetricVector {
  return { labels: labels(metric, extra), value, timestamp };
}
function setup(instance: IntegrationInstance = redis) {
  let locked = false;
  // Deliberately throws if the metrics read even touches the ciphertext property.
  const snapshot = {
    id: vmId, organizationId, os: 'linux',
    agent: { id: agentId, organizationId, vmId, status: 'ACTIVE', collectorType: 'TELEGRAF' },
    monitoringConfig: { organizationId, vmId, definition: { schemaVersion: 1, profileKey: 'telegraf-native-v1',
      host: { intervalSeconds: 30 }, integrations: [instance] }, get secretsCiphertext(): never { throw new Error('Ciphertext must not be read'); } },
  };
  const withLockedVm = vi.fn(async <T>(_org: string, _vm: string, operation: (snapshot: MonitoringSnapshot) => Promise<T>) => {
    locked = true;
    try { return await operation(snapshot as unknown as MonitoringSnapshot); } finally { locked = false; }
  });
  const query = vi.fn(async (_expression: string): Promise<MetricVector[]> => { expect(locked).toBe(false); return []; });
  const queryRange = vi.fn(async (_expression: string, _from: number, _to: number, _step: number): Promise<MetricMatrix[]> => {
    expect(locked).toBe(false); return [];
  });
  const observe = vi.fn(async (): Promise<IntegrationObservation[]> => {
    expect(locked).toBe(false);
    return [{ instanceId, state: 'unknown', lastSampleAt: null, availability: 'available', freshnessSeconds: 300 }];
  });
  const service = new IntegrationMetricsService({ withLockedVm } as unknown as MonitoringRepository,
    { query, queryRange } as unknown as MetricsQueryClient, { observe } as unknown as IntegrationObservationService);
  return { service, snapshot, withLockedVm, query, queryRange, observe };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now * 1000); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('integration metrics closed query contract', () => {
  it('rejects client expressions, unknown query keys, invalid UUIDs/entities and unlisted IDs', () => {
    expect(integrationMetricsParamsSchema.safeParse({ organizationId: 'x', vmId, instanceId }).success).toBe(false);
    expect(integrationMetricsCurrentSchema.safeParse({ query: 'up' }).success).toBe(false);
    for (const input of [{ range: '7d', metric: 'redis_clients' }, { range: '1h', metric: 'sum(up)' },
      { range: '1h', metric: 'redis_clients', labels: {} }, { range: '1h', metric: 'redis_clients', entity: 'db:*' },
      { range: '1h', metric: 'redis_clients', entity: 'container:0123456789abcdef:redis-a' }])
      expect(integrationMetricsRangeSchema.safeParse(input).success).toBe(false);
    expect(() => buildIntegrationMetricExpression(context(), 'up', null, 'value')).toThrow('Invalid integration metric');
    expect(() => buildIntegrationMetricExpression(context(), 'redis_clients', 'database:db0', 'value')).toThrow('Invalid integration entity');
  });
  it('uses immutable server identities, exact native names and separate instance selectors', () => {
    const expression = buildIntegrationMetricExpression(context(), 'redis_used_memory', null, 'timestamp');
    for (const part of [`organization_id="${organizationId}"`, `vm_id="${vmId}"`, `agent_id="${agentId}"`, `integration_instance_id="${instanceId}"`])
      expect(expression).toContain(part);
    expect(expression).toContain('timestamp(redis_used_memory{');
    expect(expression).not.toContain('timestamp(max');
    expect(buildIntegrationMetricExpression(context({ ...redis, id: otherId }), 'redis_used_memory', null, 'value')).toContain(`integration_instance_id="${otherId}"`);
    expect(publicIntegrationMetricDefinitions(context()).every((definition) => Object.keys(definition).sort().join(',') ===
      'chart,description,group,key,label,semanticType,unit')).toBe(true);
  });
  it('timestamps both required same-entity operands before math; resets use native 5m rate and two samples', () => {
    const ts = buildIntegrationMetricExpression(context(), 'redis_cache_hit_percent', null, 'timestamp');
    expect(ts).toContain('timestamp(redis_keyspace_hits{');
    expect(ts).toContain('timestamp(redis_keyspace_misses{');
    expect(ts).toContain('abs('); // minimum of required source timestamps, never timestamp(expression)
    const ratio = buildIntegrationMetricExpression(context(), 'redis_memory_used_percent', null, 'value');
    expect(ratio).toContain(' > 0');
    expect(ratio).toContain('timestamp(redis_used_memory{');
    expect(ratio).toContain('timestamp(redis_maxmemory{');
    expect(ratio).toContain('<= 300');
    const rate = buildIntegrationMetricExpression(context(), 'redis_commands_per_second', null, 'value');
    expect(rate).toContain('rate(redis_total_commands_processed{');
    expect(rate).toContain('[5m]');
    expect(rate).toContain('count_over_time(');
    expect(rate).toContain('>= 2');
    expect(rate).toContain('min_over_time(');
    expect(rate).not.toContain('clamp');
  });
  it('preserves configured PG db and Redis keyspace database, never MySQL per-database globals', () => {
    expect(buildIntegrationMetricExpression(context(pg), 'postgresql_blks_hit', 'db:app', 'value')).toContain('db="app"');
    expect(() => buildIntegrationMetricExpression(context(pg), 'postgresql_blks_hit', 'db:other', 'value')).toThrow();
    expect(buildIntegrationMetricExpression(context(), 'redis_keyspace_keys', 'database:db12', 'value')).toContain('database="db12"');
    expect(buildIntegrationMetricExpression(context(), 'redis_keyspace_keys', null, 'timestamp')).toContain(',database)');
    expect(buildIntegrationMetricExpression(context(), 'redis_total_commands_processed', null, 'value')).not.toContain('database');
    const mysql: IntegrationInstance = { ...redis, kind: 'mysql', settings: { host: 'localhost', port: 3306, tls: false } };
    expect(buildIntegrationMetricExpression(context(mysql), 'mysql_questions', null, 'value')).not.toContain(',db');
  });
  it('uses exact Docker names/source12 and native total dimensions, with OS-specific semantics', () => {
    const c = context(docker);
    for (const [metric, dimension] of [['docker_container_cpu_usage_percent', 'cpu="cpu-total"'],
      ['docker_container_net_rx_bytes', 'network="total"'], ['docker_container_blkio_io_service_bytes_recursive_read', 'device="total"']]) {
      const expression = buildIntegrationMetricExpression(c, metric, 'container:0123456789ab:redis.b', 'value');
      expect(expression).toContain(dimension);
      expect(expression).toContain('source="0123456789ab"');
      expect(expression).toContain('container_name="redis.b"');
      expect(expression).toContain(',source,container_name)');
    }
    expect(buildIntegrationMetricExpression(c, 'docker_container_status_exitcode', null, 'value')).toContain('redis\\\\.b');
    expect(() => buildIntegrationMetricExpression(c, 'docker_container_cpu_usage_percent', 'container:0123456789ab:not-configured', 'value')).toThrow();
    const windows = { ...c, os: 'windows' as const };
    const metadata = publicIntegrationMetricDefinitions(windows);
    expect(metadata.find((metric) => metric.key === 'docker_container_cpu_usage_total')?.unit).toBe('100ns');
    expect(metadata.some((metric) => metric.key === 'docker_container_mem_usage_percent')).toBe(false);
    expect(metadata.some((metric) => metric.key === 'docker_container_mem_private_working_set')).toBe(true);
    expect(publicIntegrationMetricDefinitions(c).find((metric) => metric.key === 'docker_container_mem_limit')?.description).toContain('Not evidence');
  });
  it('every descriptor resolves to the approved native profile, without new field names', () => {
    const nginx: IntegrationInstance = { ...redis, kind: 'nginx', settings: { statusUrl: 'http://localhost/stub_status', tls: false } };
    const mysql: IntegrationInstance = { ...redis, kind: 'mysql', settings: { host: 'localhost', port: 3306, tls: false } };
    for (const instance of [redis, pg, mysql, nginx, docker]) for (const os of ['linux', 'windows'] as const) {
      const c = { ...context(instance), os };
      for (const metric of integrationMetricDescriptors(c))
        expect(() => buildIntegrationMetricExpression(c, metric.key, null, 'value')).not.toThrow();
    }
  });
  it('decoder refuses wrong agent, configured DB, unexpected labels or malformed source, not raw label maps', () => {
    const metric = integrationMetricDescriptors(context(pg))[0];
    expect(integrationEntityFromLabels(context(pg), metric, labels(metric.key, { db: 'other' }))).toBeUndefined();
    expect(integrationEntityFromLabels(context(pg), metric, labels(metric.key, { db: 'app' }))).toBe('db:app');
    expect(integrationEntityFromLabels(context(pg), metric, labels(metric.key, { db: 'app', host: 'sensitive' }))).toBeUndefined();
    expect(integrationEntityFromLabels(context(pg), metric, labels(metric.key, { db: 'app', agent_id: otherId }))).toBeUndefined();
  });
  it('exposes only vm.read human routes with no-store metadata', () => {
    expect(Reflect.getMetadata(PATH_METADATA, IntegrationMetricsController)).toBe('organizations/:organizationId/vms/:vmId/integrations/:instanceId/metrics');
    expect(Reflect.getMetadata(GUARDS_METADATA, IntegrationMetricsController).map((guard: { name: string }) => guard.name)).toEqual(['CognitoAuthGuard', 'PermissionsGuard']);
    for (const method of ['current', 'range'] as const) {
      const handler = IntegrationMetricsController.prototype[method];
      expect(Reflect.getMetadata(HEADERS_METADATA, handler)).toContainEqual({ name: 'Cache-Control', value: 'no-store' });
      expect(Reflect.getMetadata('required_permissions', handler)).toEqual(['vm.read']);
    }
  });
});

describe('integration metrics authorized service', () => {
  it('checks tenant/config/instance before queries or cache, and releases the VM lock first', async () => {
    const s = setup();
    await expect(s.service.getCurrent(otherId, vmId, instanceId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(s.service.getCurrent(organizationId, vmId, otherId)).rejects.toBeInstanceOf(NotFoundException);
    expect(s.query).not.toHaveBeenCalled();
    await s.service.getCurrent(organizationId, vmId, instanceId);
    expect(s.withLockedVm).toHaveBeenCalledTimes(3);
    expect(s.query).toHaveBeenCalledTimes(2);
    expect(s.observe).toHaveBeenCalledOnce();
    expect(s.query.mock.calls[1][0]).toContain('timestamp(redis_clients{');
    expect(s.query.mock.calls[1][0]).toContain(' or ');
    expect(s.query.mock.calls[1][0]).not.toContain('timestamp(label_replace');
  });
  it('disabled current, unknown OS, revoked/legacy agent never query, even after a cache hit', async () => {
    const s = setup();
    await s.service.getCurrent(organizationId, vmId, instanceId);
    const config = s.snapshot.monitoringConfig.definition;
    config.integrations = [{ ...redis, enabled: false }];
    expect((await s.service.getCurrent(organizationId, vmId, instanceId)).dataState).toBe('disabled');
    config.integrations = [redis];
    for (const [property, value] of [['status', 'REVOKED'], ['collectorType', 'LEGACY']]) {
      const agent = s.snapshot.agent as unknown as Record<string, string>;
      const original = agent[property]; agent[property] = value;
      expect((await s.service.getCurrent(organizationId, vmId, instanceId)).dataState).toBe('unsupported');
      agent[property] = original;
    }
    s.snapshot.os = 'plan9';
    expect((await s.service.getCurrent(organizationId, vmId, instanceId)).dataState).toBe('unsupported');
    expect(s.query).toHaveBeenCalledTimes(2);
  });
  it('retains valid zero counters but reports denominator0, insufficient rate, stale/future/null as missing, not healthy zeros', async () => {
    const s = setup();
    s.query.mockResolvedValueOnce([vector('redis_clients', 0), vector('redis_used_memory', 123), vector('redis_maxmemory', 0),
      vector('redis_uptime', 123), vector('redis_evicted_keys', Infinity), vector('redis_blocked_clients', -1)])
      .mockResolvedValueOnce([vector('redis_clients', now - 30), vector('redis_used_memory', now - 301), vector('redis_maxmemory', now - 30),
        vector('redis_uptime', now + 1), vector('redis_commands_per_second', now - 30), vector('redis_memory_used_percent', now - 30)]);
    const result = await s.service.getCurrent(organizationId, vmId, instanceId);
    const reading = (key: string) => result.readings.find((item) => item.key === key)!;
    expect(reading('redis_clients')).toMatchObject({ value: 0, state: 'fresh' });
    expect(reading('redis_memory_used_percent')).toMatchObject({ value: null, state: 'not-applicable' });
    expect(reading('redis_commands_per_second')).toMatchObject({ value: null, state: 'no-data' });
    expect(reading('redis_used_memory')).toMatchObject({ value: null, state: 'stale', lastSampleAt: new Date((now - 301) * 1000).toISOString() });
    for (const key of ['redis_uptime', 'redis_evicted_keys', 'redis_blocked_clients']) expect(reading(key).value).toBeNull();
    expect(reading('redis_uptime').lastSampleAt).toBeNull();
    expect(s.observe).not.toHaveBeenCalled();
  });
  it('presence fallback is header-only after lock, and unavailable is an error rather than empty success', async () => {
    const s = setup();
    s.observe.mockResolvedValueOnce([{ instanceId, state: 'stale', lastSampleAt: new Date((now - 1000) * 1000).toISOString(), availability: 'available', freshnessSeconds: 300 }]);
    const result = await s.service.getCurrent(organizationId, vmId, instanceId);
    expect(result.dataState).toBe('stale');
    expect(result.lastSampleAt).toBe(new Date((now - 1000) * 1000).toISOString());
    expect(result.readings.every((reading) => reading.value === null && reading.lastSampleAt === null)).toBe(true);
    s.observe.mockResolvedValueOnce([{ instanceId, state: 'unknown', lastSampleAt: null, availability: 'unavailable', freshnessSeconds: 300 }]);
    await expect(s.service.getCurrent(organizationId, vmId, instanceId)).rejects.toMatchObject({ status: 503 });
    const failed = setup();
    failed.query.mockRejectedValue(new Error('private AMP endpoint/error'));
    await expect(failed.service.getCurrent(organizationId, vmId, instanceId)).rejects.toMatchObject({ status: 503 });
    expect(failed.observe).not.toHaveBeenCalled();
  });
  it('preserves Docker lifecycle source identity and CPU above100, caps/truncates100 entities and discards unauthorized rows', async () => {
    const s = setup(docker);
    const entities = Array.from({ length: 101 }, (_, i) => ({ source: i.toString(16).padStart(12, '0'), container_name: 'redis-a' }));
    s.query.mockResolvedValueOnce([...entities.map((entity) => vector('docker_container_cpu_usage_percent', 245, entity)),
      vector('docker_container_cpu_usage_percent', 50, { source: 'ffffffffffff', container_name: 'unselected' })])
      .mockResolvedValueOnce(entities.map((entity) => vector('docker_container_cpu_usage_percent', now - 10, entity)));
    const result = await s.service.getCurrent(organizationId, vmId, instanceId);
    expect(result.entities).toHaveLength(100);
    expect(result.entitiesTruncated).toBe(true);
    expect(result.readings.filter((reading) => reading.key === 'docker_container_cpu_usage_percent').every((reading) => reading.value === 245)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('unselected');
    expect(result.entities[0].key).toBe('container:000000000000:redis-a');
  });
  it('cache is scoped by current authorized agent/settings, dedupes pending work, and freshness is recomputed', async () => {
    const s = setup();
    s.query.mockResolvedValueOnce([vector('redis_clients', 3)]).mockResolvedValueOnce([vector('redis_clients', now - 295)]);
    const [first, second] = await Promise.all([s.service.getCurrent(organizationId, vmId, instanceId), s.service.getCurrent(organizationId, vmId, instanceId)]);
    expect(first.readings[0].value).toBe(3); expect(second.readings[0].value).toBe(3);
    expect(s.query).toHaveBeenCalledTimes(2);
    vi.setSystemTime((now + 10) * 1000);
    expect((await s.service.getCurrent(organizationId, vmId, instanceId)).readings[0]).toMatchObject({ value: null, state: 'stale' });
    expect(s.query).toHaveBeenCalledTimes(2);
    s.snapshot.agent.id = otherId;
    await s.service.getCurrent(organizationId, vmId, instanceId);
    expect(s.query).toHaveBeenCalledTimes(4);
    s.snapshot.monitoringConfig.definition.integrations = [{ ...redis, settings: { ...redis.settings, port: 6380 } }];
    await s.service.getCurrent(organizationId, vmId, instanceId);
    expect(s.query).toHaveBeenCalledTimes(6);
    s.snapshot.organizationId = otherId;
    await expect(s.service.getCurrent(organizationId, vmId, instanceId)).rejects.toBeInstanceOf(NotFoundException);
    expect(s.query).toHaveBeenCalledTimes(6);
  });
  it('range is one exact metric/entity with inclusive<=300 points, timestamp-gated gaps and retained disabled history', async () => {
    const s = setup({ ...redis, enabled: false });
    s.queryRange.mockImplementation(async (_expression, from, to, step) => [{ labels: labels('redis_clients'), values:
      [{ timestamp: from, value: _expression.includes('timestamp(redis_clients{') && _expression.includes(' and ') && !_expression.includes('time() -') ? from - 5 : 10 },
        { timestamp: from + step, value: _expression.includes('time() -') ? 15 : from + step - 301 },
        { timestamp: from + step * 2, value: _expression.includes('time() -') ? 15 : from + step * 2 + 1 },
        { timestamp: to + step, value: 2 }] }]);
    for (const range of ['15m', '1h', '6h', '24h'] as const) {
      const result = await s.service.getRange(organizationId, vmId, instanceId, { range, metric: 'redis_clients' });
      expect(result.points.length).toBeLessThanOrEqual(300);
      expect(result.points[0].value).toBe(10);
      expect(result.points[1].value).toBeNull(); expect(result.points[2].value).toBeNull();
      expect(result.points.at(-1)!.timestamp <= result.to).toBe(true);
    }
    expect(s.observe).not.toHaveBeenCalled();
    await expect(s.service.getRange(organizationId, vmId, instanceId, { range: '1h', metric: 'up' })).rejects.toThrow();
    const d = setup(docker);
    await expect(d.service.getRange(organizationId, vmId, instanceId, { range: '1h', metric: 'docker_container_cpu_usage_percent' })).rejects.toThrow('entity is required');
    expect(d.queryRange).not.toHaveBeenCalled();
  });
});

describe('approved narrow PostgreSQL observation presence seam', () => {
  it('uses escaped configured DB only; drops different DB and invalid/missing DB without wildcard query', async () => {
    const query = vi.fn(async (_expression: string): Promise<MetricVector[]> => [{ labels: {
      organization_id: organizationId, vm_id: vmId, agent_id: agentId, integration_instance_id: instanceId,
      __ops_observation_family: 'postgresql_numbackends', db: 'other' }, value: now - 10, timestamp: now }]);
    const provider = { assertEnabled: vi.fn(), query } as unknown as MetricsQueryClient;
    const service = new IntegrationObservationService(provider);
    expect((await service.observe(identity, [pg]))[0].lastSampleAt).toBeNull();
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.every(([expression]) => expression.includes('db="app"') && !expression.includes('db!=""'))).toBe(true);
    const malformed = { ...pg, settings: { ...pg.settings, database: '' } };
    expect((await service.observe(identity, [malformed]))[0].availability).toBe('unavailable');
    expect(query).toHaveBeenCalledTimes(2);
  });
  it('same UUID changing database invalidates presence cache and returns only matching DB', async () => {
    const query = vi.fn(async (expression: string): Promise<MetricVector[]> => [{ labels: {
      organization_id: organizationId, vm_id: vmId, agent_id: agentId, integration_instance_id: instanceId,
      __ops_observation_family: 'postgresql_numbackends', db: expression.includes('db="second"') ? 'second' : 'app' },
      value: expression.includes('db="second"') ? now - 20 : now - 10, timestamp: now }]);
    const service = new IntegrationObservationService({ assertEnabled: vi.fn(), query } as unknown as MetricsQueryClient);
    const first = await service.observe(identity, [pg]);
    const changed = await service.observe(identity, [{ ...pg, settings: { ...pg.settings, database: 'second' } }]);
    expect(query).toHaveBeenCalledTimes(2);
    expect(first[0].lastSampleAt).not.toBe(changed[0].lastSampleAt);
  });
});
