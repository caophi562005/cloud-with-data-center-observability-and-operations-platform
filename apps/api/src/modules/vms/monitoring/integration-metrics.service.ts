import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { MetricsQueryClient, metricsUnavailable } from '../../../infrastructure/metrics/metrics-query.client.js';
import type { MetricMatrix, MetricVector } from '../../../infrastructure/metrics/metrics.types.js';
import { resolveVmMetricPlatform } from '../vm-metrics-capabilities.js';
import { markMetric } from '../vm-metrics.telegraf-contract.js';
import { IntegrationObservationService } from './integration-observation.service.js';
import { MonitoringRepository } from './monitoring.repository.js';
import { parseMonitoringDefinition } from './monitoring.schema.js';
import { integrationMetricsParamsSchema, integrationMetricsRangeSchema } from './integration-metrics.schema.js';
import {
  buildIntegrationMetricExpression, getIntegrationMetric, integrationEntityFromLabels, integrationMetricDescriptors,
  integrationMetricUnavailable, publicIntegrationMetricDefinitions, validateIntegrationEntity,
  INTEGRATION_FRESH_SECONDS, INTEGRATION_METRIC_LABEL, INTEGRATION_METRICS_REVISION, INTEGRATION_RANGE_SECONDS,
  type MetricDescriptor,
} from './integration-metrics.contract.js';
import type {
  IntegrationMetricReading, IntegrationMetricsCurrent, IntegrationMetricsHistory, IntegrationMetricsRange, IntegrationQueryContext,
} from './integration-metrics.types.js';

type CurrentRows = { values: MetricVector[]; timestamps: MetricVector[] };
type RangeRows = { values: MetricMatrix[]; timestamps: MetricMatrix[] };
const valid = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const rowKey = (key: string, entity: string | null) => JSON.stringify([key, entity]);

@Injectable()
export class IntegrationMetricsService {
  private readonly cache = new Map<string, { until: number; rows: CurrentRows | RangeRows }>();
  private readonly pending = new Map<string, Promise<CurrentRows | RangeRows>>();
  private running = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly repository: MonitoringRepository, private readonly provider: MetricsQueryClient,
    private readonly observation: IntegrationObservationService) {}

  private async context(organizationId: string, vmId: string, instanceId: string): Promise<IntegrationQueryContext> {
    const params = integrationMetricsParamsSchema.safeParse({ organizationId, vmId, instanceId });
    if (!params.success) throw new BadRequestException('Invalid integration scope');
    return this.repository.withLockedVm(params.data.organizationId, params.data.vmId, async (snapshot) => {
      if (!snapshot.monitoringConfig || snapshot.id !== params.data.vmId || snapshot.organizationId !== params.data.organizationId ||
        snapshot.monitoringConfig.organizationId !== params.data.organizationId || snapshot.monitoringConfig.vmId !== params.data.vmId)
        throw new NotFoundException('Integration not found');
      const definition = parseMonitoringDefinition(snapshot.monitoringConfig.definition);
      const instance = definition.integrations.find((item) => item.id === params.data.instanceId);
      if (!instance) throw new NotFoundException('Integration not found');
      const platform = resolveVmMetricPlatform(snapshot.os);
      const os = platform === 'unknown' ? null : platform;
      const agent = snapshot.agent;
      const identity = agent && agent.organizationId === params.data.organizationId && agent.vmId === params.data.vmId
        ? { organizationId: params.data.organizationId, vmId: params.data.vmId, agentId: agent.id } : null;
      // Only the parsed nonsecret instance and trusted identity leave the lock, never the snapshot/ciphertext.
      return { identity, os, instance, compatible: Boolean(identity && os && agent?.status === 'ACTIVE' && agent.collectorType === 'TELEGRAF') };
    });
  }

  async getCurrent(organizationId: string, vmId: string, instanceId: string): Promise<IntegrationMetricsCurrent> {
    const context = await this.context(organizationId, vmId, instanceId); // Always before even a cache lookup.
    const metrics = integrationMetricDescriptors(context);
    const response: IntegrationMetricsCurrent = {
      kind: context.instance.kind, instanceId: context.instance.id, queriedAt: iso(Date.now() / 1000), enabled: context.instance.enabled,
      dataState: !context.compatible ? 'unsupported' : !context.instance.enabled ? 'disabled' : 'no-data', lastSampleAt: null,
      definitions: publicIntegrationMetricDefinitions(context), readings: [], entities: [], entitiesTruncated: false,
    };
    if (!context.compatible || !context.instance.enabled) {
      response.readings = metrics.map((metric) => ({ key: metric.key, entityKey: this.defaultEntity(context, metric), value: null,
        lastSampleAt: null, state: !context.compatible ? 'unsupported' : 'no-data',
        reason: !context.compatible ? 'An active native agent and supported operating system are required' : 'Integration is disabled' }));
      return response;
    }
    const available = metrics.filter((metric) => !integrationMetricUnavailable(context, metric));
    const rows = await this.cached<CurrentRows>(this.cacheKey(context, 'current'), async () => {
      const expression = (mode: 'value' | 'timestamp') => available.map((metric) => markMetric(
        buildIntegrationMetricExpression(context, metric.key, null, mode), metric.key, INTEGRATION_METRIC_LABEL)).join(' or ');
      const [values, timestamps] = await Promise.all([
        this.query(() => this.provider.query(expression('value'))), this.query(() => this.provider.query(expression('timestamp'))),
      ]);
      return { values, timestamps };
    });
    const now = Date.now() / 1000;
    response.queriedAt = iso(now);
    const values = this.currentIndex(context, metrics, rows.values, false, now);
    const times = this.currentIndex(context, metrics, rows.timestamps, true, now);
    const entities = new Set<string>();
    for (const metric of metrics) {
      const defaultEntity = this.defaultEntity(context, metric);
      if (defaultEntity) entities.add(defaultEntity);
    }
    for (const row of [...rows.timestamps, ...rows.values]) {
      const metric = metrics.find((item) => item.key === row.labels[INTEGRATION_METRIC_LABEL]);
      if (!metric) continue;
      const entity = integrationEntityFromLabels(context, metric, row.labels);
      if (entity && (times.has(rowKey(metric.key, entity)) || values.has(rowKey(metric.key, entity)))) entities.add(entity);
    }
    const selected = [...entities].sort().slice(0, 100);
    response.entitiesTruncated = entities.size > selected.length;
    response.entities = selected.map((key) => ({ key, label: key.startsWith('container:') ? `${key.slice(23)} · ${key.slice(10, 22)}` : key.slice(key.indexOf(':') + 1) }));
    for (const metric of metrics) {
      const targets: Array<string | null> = metric.grouping === 'global' ? [null] : selected.filter((entity) =>
        metric.grouping === 'db' ? entity.startsWith('db:') : metric.grouping === 'database' ? entity.startsWith('database:') : entity.startsWith('container:'));
      if (!targets.length) targets.push(null);
      for (const entity of targets) response.readings.push(this.reading(context, metric, entity,
        values.get(rowKey(metric.key, entity)), times.get(rowKey(metric.key, entity)), now));
    }
    const samples = response.readings.map((reading) => reading.lastSampleAt).filter((time): time is string => time !== null);
    response.lastSampleAt = samples.length ? samples.sort().at(-1)! : null;
    response.dataState = response.readings.some((reading) => reading.state === 'fresh') ? 'fresh'
      : response.readings.some((reading) => reading.state === 'stale') ? 'stale' : 'no-data';
    if (!response.lastSampleAt) {
      // Existing bounded primary-family history, AFTER releasing the VM lock. It is presence only.
      const presence = await this.query(() => this.observation.observe(context.identity!, [context.instance]));
      if (!presence.length || presence[0].availability !== 'available') throw metricsUnavailable();
      const last = presence[0].lastSampleAt === null ? NaN : Date.parse(presence[0].lastSampleAt) / 1000;
      if (valid(last) && last > 0 && last <= now && now - last <= 604800) {
        response.lastSampleAt = iso(last);
        response.dataState = now - last <= INTEGRATION_FRESH_SECONDS ? 'fresh' : 'stale';
      }
    }
    return response;
  }

  async getRange(organizationId: string, vmId: string, instanceId: string,
    input: { range: IntegrationMetricsRange; metric: string; entity?: string }): Promise<IntegrationMetricsHistory> {
    const context = await this.context(organizationId, vmId, instanceId);
    const parsed = integrationMetricsRangeSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException('Invalid integration range');
    const metric = getIntegrationMetric(context, parsed.data.metric);
    const entity = parsed.data.entity ?? this.defaultEntity(context, metric);
    validateIntegrationEntity(context, metric, entity);
    if (entity === null && metric.grouping !== 'global') throw new BadRequestException('An integration entity is required');
    const seconds = INTEGRATION_RANGE_SECONDS[parsed.data.range];
    const step = Math.max(15, Math.ceil(seconds / 299));
    const to = Math.floor(Date.now() / 30000) * 30;
    const from = to - seconds;
    const unavailable = integrationMetricUnavailable(context, metric);
    const response: IntegrationMetricsHistory = {
      kind: context.instance.kind, instanceId: context.instance.id, key: metric.key, entityKey: entity, range: parsed.data.range,
      from: iso(from), to: iso(to), step, points: [], state: 'no-data', reason: null,
    };
    if (!context.compatible || unavailable) return { ...response, state: !context.compatible ? 'unsupported' : 'not-applicable',
      reason: unavailable ?? 'An active native agent and supported operating system are required' };
    const rows = await this.cached<RangeRows>(this.cacheKey(context, ['range', parsed.data.range, metric.key, entity, to]), async () => {
      const [values, timestamps] = await Promise.all([
        this.query(() => this.provider.queryRange(buildIntegrationMetricExpression(context, metric.key, entity, 'value'), from, to, step)),
        this.query(() => this.provider.queryRange(buildIntegrationMetricExpression(context, metric.key, entity, 'timestamp'), from, to, step)),
      ]);
      return { values, timestamps };
    });
    const values = this.rangeIndex(context, metric, entity, rows.values, from, to, step);
    const times = this.rangeIndex(context, metric, entity, rows.timestamps, from, to, step);
    const readings: IntegrationMetricReading[] = [];
    for (let evaluation = from; evaluation <= to; evaluation += step) {
      const reading = this.reading(context, metric, entity, values.get(evaluation), times.get(evaluation), evaluation);
      readings.push(reading);
      response.points.push({ timestamp: iso(evaluation), value: reading.value });
    }
    response.state = readings.some((reading) => reading.state === 'fresh') ? 'fresh' : readings.some((reading) => reading.state === 'stale') ? 'stale'
      : readings.some((reading) => reading.state === 'not-applicable') ? 'not-applicable' : 'no-data';
    response.reason = response.state === 'fresh' ? null : readings.find((reading) => reading.reason)?.reason ?? 'No samples in the selected range';
    return response; // Disabled instances may inspect retained history, never a current collecting state.
  }

  private defaultEntity(context: IntegrationQueryContext, metric: MetricDescriptor): string | null {
    return metric.grouping === 'db' && context.instance.kind === 'postgresql' ? `db:${context.instance.settings.database}` : null;
  }
  private reading(context: IntegrationQueryContext, metric: MetricDescriptor, entity: string | null,
    value: number | undefined, time: number | undefined, now: number): IntegrationMetricReading {
    const base = { key: metric.key, entityKey: entity, value: null, lastSampleAt: null };
    const unavailable = integrationMetricUnavailable(context, metric);
    if (unavailable) return { ...base, state: 'not-applicable', reason: unavailable };
    if (!valid(time) || time <= 0 || time > now) return { ...base, state: 'no-data', reason: 'No valid source sample' };
    const timestamp = iso(time);
    if (now - time > INTEGRATION_FRESH_SECONDS) return { ...base, lastSampleAt: timestamp, state: 'stale', reason: 'Source sample is older than 300 seconds' };
    if (!valid(value)) return { ...base, lastSampleAt: timestamp, state: metric.semanticType === 'ratio' ? 'not-applicable' : 'no-data',
      reason: metric.semanticType === 'ratio' ? 'No valid positive denominator or ratio' : metric.semanticType === 'rate' ? 'Insufficient valid counter samples' : 'Metric input is unavailable' };
    return { ...base, value, lastSampleAt: timestamp, state: 'fresh', reason: null };
  }
  private currentIndex(context: IntegrationQueryContext, metrics: MetricDescriptor[], rows: MetricVector[], timestamp: boolean, now: number): Map<string, number> {
    const result = new Map<string, number>();
    const duplicates = new Set<string>();
    for (const row of rows) {
      const metric = metrics.find((item) => item.key === row.labels[INTEGRATION_METRIC_LABEL]);
      if (!metric || !valid(row.value) || !valid(row.timestamp) || row.timestamp > now || now - row.timestamp > INTEGRATION_FRESH_SECONDS ||
        (timestamp && (row.value <= 0 || row.value > now))) continue;
      const entity = integrationEntityFromLabels(context, metric, row.labels);
      if (entity === undefined) continue;
      const key = rowKey(metric.key, entity);
      if (result.has(key)) { duplicates.add(key); result.delete(key); } else if (!duplicates.has(key)) result.set(key, row.value);
    }
    return result;
  }
  private rangeIndex(context: IntegrationQueryContext, metric: MetricDescriptor, entity: string | null,
    rows: MetricMatrix[], from: number, to: number, step: number): Map<number, number> {
    const matches = rows.filter((row) => integrationEntityFromLabels(context, metric, row.labels) === entity);
    if (matches.length !== 1) return new Map();
    const result = new Map<number, number>();
    const duplicates = new Set<number>();
    for (const sample of matches[0].values) {
      if (!valid(sample.value) || !valid(sample.timestamp) || sample.timestamp < from || sample.timestamp > to ||
        (sample.timestamp - from) % step !== 0) continue;
      if (result.has(sample.timestamp)) { duplicates.add(sample.timestamp); result.delete(sample.timestamp); }
      else if (!duplicates.has(sample.timestamp)) result.set(sample.timestamp, sample.value);
    }
    return result;
  }
  private cacheKey(context: IntegrationQueryContext, selection: unknown): string {
    return createHash('sha256').update(JSON.stringify([INTEGRATION_METRICS_REVISION, context.identity, context.os, context.instance, selection])).digest('hex');
  }
  private async cached<T extends CurrentRows | RangeRows>(key: string, load: () => Promise<T>): Promise<T> {
    const now = Date.now();
    for (const [old, entry] of this.cache) if (entry.until <= now) this.cache.delete(old);
    const hit = this.cache.get(key);
    if (hit) return hit.rows as T;
    const pending = this.pending.get(key);
    if (pending) return pending as Promise<T>;
    if (this.pending.size >= 32) throw metricsUnavailable();
    const promise = load().then((rows) => {
      if (this.cache.size >= 32) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, { until: Date.now() + 30000, rows }); return rows;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }
  private async query<T>(operation: () => Promise<T>): Promise<T> {
    if (this.running >= 4) {
      if (this.waiters.length >= 64) throw metricsUnavailable();
      await new Promise<void>((resolve, reject) => {
        const resume = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => {
          const index = this.waiters.indexOf(resume);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(metricsUnavailable('timeout'));
        }, 5000);
        this.waiters.push(resume);
      });
    } else this.running++;
    try { return await operation(); }
    catch { throw metricsUnavailable(); }
    finally { const next = this.waiters.shift(); if (next) next(); else this.running--; }
  }
}
