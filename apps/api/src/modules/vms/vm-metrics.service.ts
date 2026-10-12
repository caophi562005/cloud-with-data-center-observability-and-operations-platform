import {
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  metricsConfig,
  type MetricsConfig,
  type VmHealthPolicy,
} from '../../config/metrics.config.js';
import { ApplicationNotFoundError } from '../../common/errors/application-conflict.error.js';
import {
  MetricsQueryClient,
  metricsUnavailable,
} from '../../infrastructure/metrics/metrics-query.client.js';
import type { MetricVector } from '../../infrastructure/metrics/metrics.types.js';
import {
  emptyVmMetrics,
  deriveVmHealth,
  VM_HEALTH_POLICY,
} from './vm-health.js';
import {
  buildLinuxVmExpressions,
  CURRENT_METRICS,
  RANGE_METRICS,
  type VmMetricBinding,
  type CurrentMetric,
} from './vm-metrics.promql.js';
import {
  resolveMetricsWindow,
  vmMetricsQuerySchema,
  type VmMetricsQuery,
} from './schemas/vm-metrics.schema.js';
import { VmsRepository } from './vms.repository.js';
import type {
  EnrichedVmRecord,
  VmCurrentMetrics,
  VmMetricsRange,
  VmRecord,
  VmMetricPoint,
} from './vms.types.js';
import { buildWindowsVmExpressions } from './vm-metrics.windows.promql.js';
import { getVmMetricsCapabilities, resolveVmMetricPlatform } from './vm-metrics-capabilities.js';
import type { VmMetricExpressions } from './vms.types.js';
interface CurrentData {
  values: MetricVector[];
  sources: MetricVector[];
  history: MetricVector[];
}
interface CacheEntry {
  until: number;
  value: unknown;
}
const isActive = (vm: VmRecord) =>
  vm.agent?.status === 'ACTIVE' && Boolean(vm.agent.id);
function matches(
  labels: Record<string, string>,
  org: string,
  binding: VmMetricBinding,
): boolean {
  return (
    labels.organization_id === org &&
    labels.vm_id === binding.vmId &&
    labels.agent_id === binding.agentId
  );
}
function bindingFor(vm: VmRecord): VmMetricBinding {
  return { vmId: vm.id, agentId: vm.agent!.id, platform: resolveVmMetricPlatform(vm.os) };
}
function sourceTime(
  rows: MetricVector[],
  org: string,
  binding: VmMetricBinding,
  name: string,
  now: number,
): number | null {
  const values = rows
    .filter(
      (row) =>
        matches(row.labels, org, binding) && row.labels.__ops_metric === name,
    )
    .map((row) => row.value)
    .filter(
      (n): n is number =>
        n !== null &&
        Number.isFinite(n) &&
        n > 0 &&
        n <= now &&
        now - n <= 604800,
    );
  return values.length ? Math.max(...values) : null;
}
function latestSourceTime(
  rows: MetricVector[],
  org: string,
  binding: VmMetricBinding,
  now: number,
): number | null {
  const times = [...CURRENT_METRICS, 'heartbeat']
    .map((name) => sourceTime(rows, org, binding, name, now))
    .filter((time): time is number => time !== null);
  return times.length ? Math.max(...times) : null;
}
function iso(seconds: number | null): string | null {
  return seconds === null ? null : new Date(seconds * 1000).toISOString();
}
function normalizeValue(
  name: CurrentMetric,
  value: number | null,
): number | null {
  if (value === null || !Number.isFinite(value) || value < 0) return null;
  return ['cpu', 'memory', 'disk'].includes(name)
    ? Math.min(100, value)
    : value;
}

@Injectable()
export class VmMetricsService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private running = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly policy: VmHealthPolicy;
  constructor(
    private readonly repository: VmsRepository,
    private readonly provider: MetricsQueryClient,
    @Optional() @Inject(metricsConfig.KEY) settings?: MetricsConfig,
  ) {
    this.policy = settings?.health ?? VM_HEALTH_POLICY;
  }
  async current(
    organizationId: string,
    vmId: string,
  ): Promise<VmCurrentMetrics> {
    const vm = await this.authorizedVm(organizationId, vmId);
    if (!isActive(vm)) return this.empty(vm);
    this.provider.assertEnabled();
    if (resolveVmMetricPlatform(vm.os) === 'unknown') return this.empty(vm);
    return this.materialize(
      organizationId,
      vm,
      await this.loadCurrent(organizationId, [vm]),
    );
  }
  async range(
    organizationId: string,
    vmId: string,
    query: VmMetricsQuery,
  ): Promise<VmMetricsRange> {
    const vm = await this.authorizedVm(organizationId, vmId);
    const parsed = vmMetricsQuerySchema.parse(query);
    // Presets align to their evaluation step; explicit bounds and query arguments remain exact.
    const window = resolveMetricsWindow(parsed, Date.now() / 1000);
    const result: VmMetricsRange = {
      metricsCapabilities: getVmMetricsCapabilities(resolveVmMetricPlatform(vm.os)),
      from: iso(window.from)!,
      to: iso(window.to)!,
      step: window.step,
      series: {
        cpu: [],
        memory: [],
        disk: [],
        networkRx: [],
        networkTx: [],
        load: [],
      },
    };
    if (!isActive(vm)) return result;
    this.provider.assertEnabled();
    const binding = bindingFor(vm);
    if (binding.platform === 'unknown') return result;
    const expressions = this.profiles(organizationId, [binding])[0]!;
    const series = await this.cached(
      this.key('range', organizationId, [vm], window),
      async () => {
        const data = await Promise.all(
          RANGE_METRICS.filter((name) => expressions.values[name] !== undefined).map(async (name) => {
            const rows = await this.query(() =>
              this.provider.queryRange(
                expressions.values[name]!,
                window.from,
                window.to,
                window.step,
              ),
            );
            const matching = rows.filter((row) =>
              matches(row.labels, organizationId, binding),
            );
            // Each query aggregates to exactly one series for this identity. Never merge
            // duplicate identities, even when their timestamp sets do not overlap.
            if (matching.length > 1) throw metricsUnavailable();
            const expectedPoints =
              Math.floor((window.to - window.from) / window.step) + 1;
            if (expectedPoints > 1000) throw metricsUnavailable();
            const epochStart = Math.ceil(window.from / window.step) * window.step;
            const distinctGrids = window.from !== epochStart;
            const collectPoints = (gridStart: number, otherGridStart?: number) => {
              const capacity = Math.max(
                0,
                Math.floor((window.to - gridStart) / window.step) + 1,
              );
              const points = new Map<number, number | null>();
              for (const point of matching[0]?.values ?? []) {
                if (!Number.isFinite(point.timestamp)) continue;
                const index = Math.round((point.timestamp - gridStart) / window.step);
                const timestamp = gridStart + index * window.step;
                // Only numeric drift on a known grid is canonicalized; never shift
                // provider samples to a different phase or expand explicit bounds.
                if (
                  index < 0 ||
                  index >= capacity ||
                  timestamp < window.from ||
                  timestamp > window.to ||
                  Math.abs(point.timestamp - timestamp) > 0.001
                )
                  continue;
                // An exact sample on the other known grid never belongs to this
                // phase, even when its own canonical timestamp is outside bounds.
                if (
                  otherGridStart !== undefined &&
                  point.timestamp ===
                    otherGridStart +
                      Math.round((point.timestamp - otherGridStart) / window.step) *
                        window.step
                )
                  continue;
                const value = normalizeValue(name, point.value);
                points.set(timestamp, points.has(timestamp) ? null : value);
              }
              return points;
            };
            const requestedPoints = collectPoints(
              window.from,
              distinctGrids ? epochStart : undefined,
            );
            const epochPoints = distinctGrids
              ? collectPoints(epochStart, window.from)
              : new Map<number, number | null>();
            // Accept one known grid only. Mixed phases or non-exact drift fitting
            // both distinct grids are ambiguous; fail closed rather than shift.
            if (requestedPoints.size && epochPoints.size) throw metricsUnavailable();
            const points = requestedPoints.size ? requestedPoints : epochPoints;
            if (points.size > expectedPoints || points.size > 1000)
              throw metricsUnavailable();
            const normalized: VmMetricPoint[] = [...points]
              .sort(([a], [b]) => a - b)
              .map(([timestamp, value]) => ({
                timestamp: iso(timestamp)!,
                value,
              }));
            return [name, normalized] as const;
          }),
        );
        return { ...result.series, ...Object.fromEntries(data) } as VmMetricsRange['series'];
      },
    );
    return { ...result, series };
  }
  async enrichPage(
    organizationId: string,
    records: VmRecord[],
  ): Promise<EnrichedVmRecord[]> {
    if (
      records.some((vm) => vm.organizationId !== organizationId) ||
      records.length > 100
    )
      throw new ApplicationNotFoundError('RESOURCE_NOT_FOUND', 'VM not found');
    const active = records.filter(isActive);
    try {
      const data = active.length
        ? await this.loadCurrent(organizationId, active)
        : null;
      return records.map((vm) => ({
        ...vm,
        ...(data && isActive(vm)
          ? this.materialize(organizationId, vm, data)
          : this.empty(vm)),
      }));
    } catch (error) {
      const disabled =
        error instanceof ServiceUnavailableException &&
        (error.getResponse() as { code?: string }).code === 'METRICS_DISABLED';
      return records.map((vm) => ({
        ...vm,
        ...this.empty(vm),
        metricsState: isActive(vm)
          ? disabled
            ? 'disabled'
            : 'unavailable'
          : 'empty',
      }));
    }
  }
  private async authorizedVm(
    organizationId: string,
    vmId: string,
  ): Promise<VmRecord> {
    const vm = await this.repository.getById(organizationId, vmId);
    if (!vm || vm.organizationId !== organizationId)
      throw new ApplicationNotFoundError('RESOURCE_NOT_FOUND', 'VM not found');
    return vm;
  }
  private async loadCurrent(
    org: string,
    records: VmRecord[],
  ): Promise<CurrentData> {
    this.provider.assertEnabled();
    const bindings = records.map(bindingFor).filter((binding) => binding.platform !== 'unknown');
    if (!bindings.length) return { values: [], sources: [], history: [] };
    return this.cached(this.key('current', org, records), async () => {
      const profiles = this.profiles(org, bindings);
      const combine = (key: 'current' | 'source' | 'lastSeen', parts = profiles) => parts.map((profile) => `(${profile[key]})`).join(' or ');
      const [values, sources] = await Promise.all([
        this.query(() => this.provider.query(combine('current'))),
        this.query(() => this.provider.query(combine('source'))),
      ]);
      const now = Date.now() / 1000;
      const missing = bindings.filter(
        (binding) => latestSourceTime(sources, org, binding, now) === null,
      );
      const history = missing.length
        ? await this.query(() =>
            this.provider.query(combine('lastSeen', this.profiles(org, missing))),
          )
        : [];
      return { values, sources, history };
    });
  }
  private profiles(org: string, bindings: VmMetricBinding[]): VmMetricExpressions[] {
    const linux = bindings.filter((binding) => binding.platform === 'linux');
    const windows = bindings.filter((binding) => binding.platform === 'windows');
    return [
      ...(linux.length ? [buildLinuxVmExpressions(org, linux)] : []),
      ...(windows.length ? [buildWindowsVmExpressions(org, windows, this.policy.staleSeconds)] : []),
    ];
  }
  private materialize(
    org: string,
    vm: VmRecord,
    data: CurrentData,
  ): VmCurrentMetrics {
    const now = Date.now() / 1000;
    const binding = bindingFor(vm);
    if (binding.platform === 'unknown') return this.empty(vm);
    const metricsCapabilities = getVmMetricsCapabilities(binding.platform);
    const heartbeat = latestSourceTime(data.sources, org, binding, now);
    const history = sourceTime(data.history, org, binding, 'heartbeat', now);
    const lastSeen =
      heartbeat === null
        ? history
        : history === null
          ? heartbeat
          : Math.max(heartbeat, history);
    const fresh =
      heartbeat !== null && now - heartbeat <= this.policy.staleSeconds;
    const metrics = emptyVmMetrics();
    // Each field is independently fresh; one absent/stale family must not hide
    // other valid telemetry or a critical CPU reading from a partial exporter.
    for (const name of metricsCapabilities.supported) {
      const source = sourceTime(data.sources, org, binding, name, now);
      if (source === null || now - source > this.policy.staleSeconds) continue;
      const candidates = data.values.filter(
        (row) =>
          matches(row.labels, org, binding) && row.labels.__ops_metric === name,
      );
      if (candidates.length === 1)
        metrics[name] = normalizeValue(name, candidates[0].value);
    }
    const metricsState = Object.values(metrics).some((n) => n !== null)
      ? 'available'
      : 'empty';
    return {
      metricsCapabilities,
      sampledAt: iso(fresh ? heartbeat : null),
      lastSeenAt: iso(lastSeen),
      status: deriveVmHealth(
        metrics,
        isActive(vm),
        heartbeat,
        now,
        this.policy,
      ),
      metrics,
      metricsState,
    };
  }
  private empty(vm: VmRecord): VmCurrentMetrics {
    const platform = resolveVmMetricPlatform(vm.os);
    const stored = platform === 'unknown' && isActive(vm) ? vm.agent?.lastSeenAt : null;
    return {
      metricsCapabilities: getVmMetricsCapabilities(platform),
      sampledAt: null,
      lastSeenAt: stored && Number.isFinite(stored.getTime()) ? stored.toISOString() : null,
      status: 'DISCONNECTED',
      metrics: emptyVmMetrics(),
      metricsState: 'empty',
    };
  }
  private key(
    kind: string,
    org: string,
    records: VmRecord[],
    window: unknown = null,
  ): string {
    return JSON.stringify([
      kind,
      org,
      records
        .map((vm) => [vm.id, vm.agent?.id, vm.agent?.status, resolveVmMetricPlatform(vm.os)])
        .sort(([a], [b]) => String(a).localeCompare(String(b))),
      window,
    ]);
  }
  private async cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const now = Date.now();
    for (const [old, entry] of this.cache)
      if (entry.until <= now) this.cache.delete(old);
    const hit = this.cache.get(key);
    if (hit) return hit.value as T;
    const pending = this.pending.get(key);
    if (pending) return pending as Promise<T>;
    if (this.pending.size >= 32) throw metricsUnavailable();
    const promise = load()
      .then((value) => {
        if (this.cache.size >= 32)
          this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, { until: Date.now() + 30000, value });
        return value;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }
  private async query<T>(request: () => Promise<T>): Promise<T> {
    if (this.running >= 4) {
      if (this.waiters.length >= 64) throw metricsUnavailable();
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    } else this.running++;
    try {
      return await request();
    } catch (error) {
      if (
        error instanceof ServiceUnavailableException &&
        (error.getResponse() as { code?: string }).code === 'METRICS_DISABLED'
      )
        throw error;
      throw metricsUnavailable();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.running--;
    }
  }
}
