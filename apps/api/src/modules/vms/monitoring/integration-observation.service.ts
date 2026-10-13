import { Inject, Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import { metricsConfig, type MetricsConfig, type VmHealthPolicy } from '../../../config/metrics.config.js';
import { MetricsQueryClient, metricsUnavailable } from '../../../infrastructure/metrics/metrics-query.client.js';
import type { MetricVector } from '../../../infrastructure/metrics/metrics.types.js';
import { VM_HEALTH_POLICY } from '../vm-health.js';
import { escapeMetricRegex, finiteNonnegative, markMetric, TELEGRAF_CONTRACT_VERSION, TELEGRAF_SERVICE_FAMILIES } from '../vm-metrics.telegraf-contract.js';
import { MAX_INTEGRATION_INSTANCES, monitoringInstanceIdSchema } from './integration-catalog.js';
import type { AgentIdentity, IntegrationInstance, IntegrationObservation } from './monitoring.types.js';

const GROUP = 'organization_id,vm_id,agent_id,integration_instance_id,db';
const HISTORY_SECONDS = 604800;

@Injectable()
export class IntegrationObservationService {
  private readonly policy: VmHealthPolicy;
  private readonly cache = new Map<string, { until: number; rows: MetricVector[] }>();
  private readonly pending = new Map<string, Promise<MetricVector[]>>();
  private running = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly provider: MetricsQueryClient,
    @Optional() @Inject(metricsConfig.KEY) settings?: MetricsConfig,
  ) {
    this.policy = settings?.health ?? VM_HEALTH_POLICY;
  }

  async observe(identity: AgentIdentity, instances: IntegrationInstance[]): Promise<IntegrationObservation[]> {
    const enabled = instances.filter((instance) => instance.enabled);
    const unknown = (availability: IntegrationObservation['availability']) => instances.map((instance) => ({
      instanceId: instance.id,
      state: instance.enabled ? 'unknown' as const : 'disabled' as const,
      lastSampleAt: null,
      availability,
      freshnessSeconds: this.freshness(instance),
    }));
    if (!enabled.length) return unknown('available');
    // Trusted identity from the authorized DB snapshot, never endpoint/client
    // parameters. Do not query malformed definitions, arbitrary metric names or IDs.
    if (instances.length > MAX_INTEGRATION_INSTANCES ||
      new Set(instances.map((instance) => instance.id)).size !== instances.length ||
      !Object.values(identity).every((id) => monitoringInstanceIdSchema.safeParse(id).success) ||
      !instances.every((instance) => monitoringInstanceIdSchema.safeParse(instance.id).success &&
        Object.hasOwn(TELEGRAF_SERVICE_FAMILIES, instance.kind) &&
        Number.isInteger(instance.intervalSeconds) && instance.intervalSeconds >= 15 && instance.intervalSeconds <= 3600 &&
        (instance.kind !== 'postgresql' || (typeof instance.settings?.database === 'string' &&
          /^[A-Za-z0-9_.-]{1,128}$/.test(instance.settings.database)))))
      return unknown('unavailable');
    try {
      this.provider.assertEnabled();
      const key = JSON.stringify([TELEGRAF_CONTRACT_VERSION, this.policy.staleSeconds, identity,
        enabled.map((instance) => [instance.id, instance.kind, instance.intervalSeconds,
          instance.kind === 'postgresql' ? instance.settings.database : null]).sort(([a], [b]) => String(a).localeCompare(String(b)))]);
      const rows = await this.cached(key, async () => {
        const query = this.expression(identity, enabled, false);
        const current = await this.query(() => this.provider.query(query));
        const now = Date.now() / 1000;
        const missing = enabled.filter((instance) => this.lastSample(current, identity, instance, now) === null);
        const history = missing.length
          ? await this.query(() => this.provider.query(this.expression(identity, missing, true))) : [];
        return [...current, ...history];
      });
      const now = Date.now() / 1000;
      return instances.map((instance) => {
        const sample = instance.enabled ? this.lastSample(rows, identity, instance, now) : null;
        const freshnessSeconds = this.freshness(instance);
        return {
          instanceId: instance.id,
          state: !instance.enabled ? 'disabled' : sample === null ? 'unknown' : now - sample <= freshnessSeconds ? 'observed' : 'stale',
          lastSampleAt: sample === null ? null : new Date(sample * 1000).toISOString(),
          availability: 'available',
          freshnessSeconds,
        };
      });
    } catch (error) {
      const disabled = error instanceof ServiceUnavailableException &&
        (error.getResponse() as { code?: string }).code === 'METRICS_DISABLED';
      // No backend/endpoint/error details leave this boundary. Config read/save
      // and control/apply state remain usable while metrics are disabled/down.
      return unknown(disabled ? 'disabled' : 'unavailable');
    }
  }

  private freshness(instance: IntegrationInstance): number {
    // Allow three configured gather intervals (15..3600s) without changing host
    // stale/5-minute CPU and rate policy or inventing samples in its gaps.
    return Math.max(this.policy.staleSeconds, instance.intervalSeconds * 3);
  }

  private expression(identity: AgentIdentity, instances: IntegrationInstance[], history: boolean): string {
    const scope = `organization_id=${JSON.stringify(identity.organizationId)},vm_id=${JSON.stringify(identity.vmId)},agent_id=${JSON.stringify(identity.agentId)}`;
    const parts: string[] = [];
    for (const kind of Object.keys(TELEGRAF_SERVICE_FAMILIES) as Array<IntegrationInstance['kind']>) {
      const selected = instances.filter((instance) => instance.kind === kind);
      const ids = selected.map((instance) => escapeMetricRegex(instance.id));
      if (!ids.length) continue;
      const selectors = kind === 'postgresql'
        ? selected.flatMap((instance) => instance.kind === 'postgresql'
          ? [`${scope},integration_instance_id=${JSON.stringify(instance.id)},db=${JSON.stringify(instance.settings.database)}`] : [])
        : [`${scope},integration_instance_id=~${JSON.stringify(ids.join('|'))}`];
      for (const labels of selectors) for (const family of TELEGRAF_SERVICE_FAMILIES[kind]) {
        const raw = `${family}{${labels}}`;
        const time = `max by (${GROUP}) (timestamp(${raw}) and ${finiteNonnegative(raw)} and (timestamp(${raw}) <= time()))`;
        const query = history ? `max_over_time((${time})[7d:60s])` : time;
        // Distinct constituent roles prevent same-label Redis fields from being
        // silently dropped by OR. PostgreSQL db remains a query grouping label.
        parts.push(markMetric(query, family, '__ops_observation_family'));
      }
    }
    return parts.map((query) => `(${query})`).join(' or ');
  }

  private lastSample(rows: MetricVector[], identity: AgentIdentity, instance: IntegrationInstance, now: number): number | null {
    if (!Number.isFinite(now) || now <= 0) return null;
    const families: readonly string[] = TELEGRAF_SERVICE_FAMILIES[instance.kind];
    const samples = rows.filter((row) => row.labels.organization_id === identity.organizationId &&
      row.labels.vm_id === identity.vmId && row.labels.agent_id === identity.agentId &&
      row.labels.integration_instance_id === instance.id && families.includes(row.labels.__ops_observation_family) &&
      (instance.kind !== 'postgresql' || row.labels.db === instance.settings.database)).map((row) => row.value)
      .filter((value): value is number => value !== null && Number.isFinite(value) && value > 0 && value <= now && now - value <= HISTORY_SECONDS);
    return samples.length ? Math.max(...samples) : null;
  }

  private async cached(key: string, load: () => Promise<MetricVector[]>): Promise<MetricVector[]> {
    const now = Date.now();
    for (const [old, entry] of this.cache) if (entry.until <= now) this.cache.delete(old);
    const hit = this.cache.get(key);
    if (hit) return hit.rows;
    const pending = this.pending.get(key);
    if (pending) return pending;
    if (this.pending.size >= 32) throw metricsUnavailable();
    const promise = load().then((rows) => {
      if (this.cache.size >= 32) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, { until: Date.now() + 30000, rows });
      return rows;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }

  private async query<T>(request: () => Promise<T>): Promise<T> {
    if (this.running >= 4) {
      if (this.waiters.length >= 64) throw metricsUnavailable();
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    } else this.running++;
    try { return await request(); }
    finally {
      const next = this.waiters.shift();
      if (next) next(); else this.running--;
    }
  }
}
