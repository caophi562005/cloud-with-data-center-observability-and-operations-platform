import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import { VmMetricsService } from './vm-metrics.service.js';
import { MetricsQueryClient } from '../../infrastructure/metrics/metrics-query.client.js';
import { VmsRepository } from './vms.repository.js';
import type { VmRecord } from './vms.types.js';
const now = 1_800_000_000;
const vm = (id = 'v', agent = 'a', org = 'o'): VmRecord => ({
  id,
  organizationId: org,
  hostname: id,
  ipAddress: null,
  os: 'Linux',
  status: 'DISCONNECTED',
  tags: [],
  createdAt: new Date(),
  updatedAt: new Date(),
  agent: {
    id: agent,
    status: 'ACTIVE',
    enrolledAt: new Date(),
    lastSeenAt: null,
  },
});
const sample = (
  metric: string,
  value: number,
  timestamp = now,
  id = 'v',
  agent = 'a',
  org = 'o',
) => ({
  labels: {
    organization_id: org,
    vm_id: id,
    agent_id: agent,
    __ops_metric: metric,
  },
  timestamp,
  value,
});
function setup() {
  const repo = { getById: vi.fn().mockResolvedValue(vm()) };
  const provider = {
    assertEnabled: vi.fn(),
    query: vi.fn(async (q: string) =>
      q.includes('[7d:60s]')
        ? [sample('heartbeat', now - 3600)]
        : q.includes('"__ops_metric", "heartbeat"')
          ? [
              sample('cpu', now),
              sample('memory', now),
              sample('heartbeat', now),
            ]
          : [sample('cpu', 0), sample('memory', 85)],
    ),
    queryRange: vi.fn().mockResolvedValue([]),
  };
  return {
    repo,
    provider,
    service: new VmMetricsService(
      repo as unknown as VmsRepository,
      provider as unknown as MetricsQueryClient,
    ),
  };
}
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
});
afterEach(() => vi.restoreAllMocks());
describe('VM telemetry service', () => {
  it.each(['Linux', 'Windows Server 2022', null])('propagates persisted capabilities on all result paths for %s', async (os) => {
    const { service, repo, provider } = setup();
    const record = { ...vm(), os };
    repo.getById.mockResolvedValue(record);
    const platform = os === null ? 'unknown' : os === 'Linux' ? 'linux' : 'windows';
    expect(await service.current('o', 'v')).toHaveProperty('metricsCapabilities.platform', platform);
    expect(await service.range('o', 'v', { range: '1h' })).toHaveProperty('metricsCapabilities.platform', platform);
    expect((await service.enrichPage('o', [record]))[0]).toHaveProperty('metricsCapabilities.platform', platform);
    provider.query.mockRejectedValue(new Error('private'));
    expect((await service.enrichPage('o', [{ ...record, id: 'error' }]))[0]).toHaveProperty('metricsCapabilities.platform', platform);
    expect((await service.enrichPage('o', [{ ...record, agent: null }]))[0]).toHaveProperty('metricsCapabilities.platform', platform);
  });
  it('unknown ACTIVE checks configuration only, never probes an outage or fabricates lastSeen', async () => {
    const { service, repo, provider } = setup();
    const stored = new Date((now - 4000) * 1000);
    const record = { ...vm(), os: null, agent: { ...vm().agent!, lastSeenAt: stored } };
    repo.getById.mockResolvedValue(record);
    expect(await service.current('o', 'v')).toMatchObject({ status: 'DISCONNECTED', metricsState: 'empty', sampledAt: null, lastSeenAt: stored.toISOString(), metricsCapabilities: { platform: 'unknown', supported: [] } });
    expect(Object.values((await service.current('o', 'v')).metrics).every((v) => v === null)).toBe(true);
    expect(Object.values((await service.range('o', 'v', { range: '1h' })).series).every((v) => v.length === 0)).toBe(true);
    expect((await service.enrichPage('o', [record]))[0].metricsState).toBe('empty');
    expect(provider.query).not.toHaveBeenCalled();
    expect(provider.queryRange).not.toHaveBeenCalled();
    provider.assertEnabled.mockImplementation(() => { throw new ServiceUnavailableException({ code: 'METRICS_DISABLED' }); });
    await expect(service.current('o', 'v')).rejects.toMatchObject({ response: { code: 'METRICS_DISABLED' } });
    await expect(service.range('o', 'v', { range: '1h' })).rejects.toMatchObject({ response: { code: 'METRICS_DISABLED' } });
    expect((await service.enrichPage('o', [record]))[0].metricsState).toBe('disabled');
    expect(provider.query).not.toHaveBeenCalled();
  });
  it('mixed_platform_exact_binding_and_budget uses two combined calls and one combined history at most', async () => {
    const { service, provider } = setup();
    const windows = { ...vm('w.*', 'wa+'), os: 'Windows Server 2022' };
    provider.query.mockResolvedValue([]);
    const rows = await service.enrichPage('o', [vm(), windows, { ...vm('unknown', 'ua'), os: null }]);
    expect(rows.map((r) => r.metricsCapabilities.platform)).toEqual(['linux', 'windows', 'unknown']);
    expect(provider.query).toHaveBeenCalledTimes(3);
    for (const [q] of provider.query.mock.calls) {
      expect(q).toContain('node_'); expect(q).toContain('windows_');
      expect(q).not.toContain('unknown'); expect(q).toContain(') or (');
      expect(q).toContain('w\\\\.\\\\*'); expect(q).toContain('wa\\\\+');
    }
  });
  it('preserves observed mixed Linux/Windows/unknown provider errors for every active-agent row', async () => {
    const stored = new Date((now - 4000) * 1000);
    const withStored = (id: string, agent: string, os: string | null): VmRecord => ({
      ...vm(id, agent), os, agent: { ...vm(id, agent).agent!, lastSeenAt: stored },
    });
    const records: VmRecord[] = [
      withStored('linux', 'linux-agent', 'Linux'),
      withStored('windows', 'windows-agent', 'Windows Server 2022'),
      withStored('unknown-stored', 'unknown-agent', null),
      { ...vm('unknown-null', 'unknown-null-agent'), os: null },
      { ...withStored('inactive', 'inactive-agent', null), agent: { ...withStored('inactive', 'inactive-agent', null).agent!, status: 'REVOKED' } },
      { ...vm('no-agent'), agent: null },
    ];
    const linuxCapabilities = { platform: 'linux', supported: ['cpu', 'memory', 'disk', 'networkRx', 'networkTx', 'load', 'uptimeHours'] };
    const windowsCapabilities = { platform: 'windows', supported: ['cpu', 'memory', 'disk', 'networkRx', 'networkTx', 'uptimeHours'] };
    const unknownCapabilities = { platform: 'unknown', supported: [] };
    const nullMetrics = { cpu: null, memory: null, disk: null, networkRx: null, networkTx: null, load: null, uptimeHours: null };
    for (const [failure, state] of [
      [new Error('private known-provider failure'), 'unavailable'],
      [new ServiceUnavailableException({ code: 'METRICS_DISABLED' }), 'disabled'],
    ] as const) {
      const { service, provider } = setup();
      provider.query.mockRejectedValue(failure);
      const rows = await service.enrichPage('o', records);
      expect(provider.assertEnabled).toHaveBeenCalledTimes(1);
      expect(provider.query).toHaveBeenCalledTimes(2);
      expect(provider.queryRange).not.toHaveBeenCalled();
      for (const [query] of provider.query.mock.calls) {
        expect(query).toContain('node_');
        expect(query).toContain('windows_');
        expect(query).not.toContain('[7d:60s]');
        for (const excluded of ['unknown-stored', 'unknown-null', 'inactive', 'no-agent']) expect(query).not.toContain(excluded);
      }
      expect(rows.map(({ metricsState }) => metricsState)).toEqual([state, state, state, state, 'empty', 'empty']);
      expect(rows.map(({ metricsCapabilities }) => metricsCapabilities)).toEqual([
        linuxCapabilities, windowsCapabilities, unknownCapabilities, unknownCapabilities, unknownCapabilities, linuxCapabilities,
      ]);
      expect(rows.map(({ lastSeenAt }) => lastSeenAt)).toEqual([null, null, stored.toISOString(), null, null, null]);
      for (const row of rows) expect(row).toMatchObject({ status: 'DISCONNECTED', sampledAt: null, metrics: nullMetrics });
      expect(rows[1].metricsCapabilities.supported).not.toContain('load');
    }
  });
  it('native Windows range uses five requests and no load, while cached platform changes invalidate', async () => {
    const { service, provider, repo } = setup();
    repo.getById.mockResolvedValue({ ...vm(), os: 'Windows Server 2022' });
    expect((await service.range('o', 'v', { range: '1h' })).series.load).toEqual([]);
    expect(provider.queryRange).toHaveBeenCalledTimes(5);
    for (const [q] of provider.queryRange.mock.calls) { expect(q).toContain('windows_'); expect(q).not.toContain('node_'); }
    await service.current('o', 'v');
    repo.getById.mockResolvedValue(vm());
    await service.current('o', 'v');
    expect(provider.query).toHaveBeenCalledTimes(4);
  });
  it('exact tuple postfilter rejects Cartesian pairs and unsupported injected load on Windows', async () => {
    const { service, provider } = setup();
    const records = [ { ...vm('w', 'wa'), os: 'Windows' }, vm('l', 'la') ];
    provider.query.mockImplementation(async (q) => q.includes('"__ops_metric", "heartbeat"') ? [sample('cpu', now, now, 'w', 'wa'), sample('load', now, now, 'w', 'wa'), sample('cpu', now, now, 'l', 'la')] : [sample('cpu', 96, now, 'w', 'wa'), sample('load', 99, now, 'w', 'wa'), sample('memory', 99, now, 'w', 'la'), sample('disk', 99, now, 'w', 'old'), sample('networkRx', 99, now, 'w', 'wa', 'foreign')]);
    const rows = await service.enrichPage('o', records);
    expect(rows[0]).toMatchObject({ status: 'CRITICAL', metrics: { cpu: 96, memory: null, disk: null, load: null, networkRx: null } });
    expect(rows[1].metrics.cpu).toBeNull();
    expect(provider.query).toHaveBeenCalledTimes(2);
  });
  it('authorizes scoped VM before cache/provider and returns real nullable values', async () => {
    const { service, repo, provider } = setup();
    expect(await service.current('o', 'v')).toEqual({
      metricsCapabilities: { platform: 'linux', supported: ['cpu', 'memory', 'disk', 'networkRx', 'networkTx', 'load', 'uptimeHours'] },
      sampledAt: new Date(now * 1000).toISOString(),
      lastSeenAt: new Date(now * 1000).toISOString(),
      status: 'WARNING',
      metricsState: 'available',
      metrics: {
        cpu: 0,
        memory: 85,
        disk: null,
        networkRx: null,
        networkTx: null,
        load: null,
        uptimeHours: null,
      },
    });
    repo.getById.mockResolvedValue(null);
    await expect(service.current('o', 'v')).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
    expect(provider.query).toHaveBeenCalledTimes(2);
  });
  it('rejects foreign tenant, VM and old agent samples rather than accepting provider labels', async () => {
    const { service, provider } = setup();
    provider.query.mockResolvedValue([
      sample('cpu', 95, now, 'v', 'old'),
      sample('cpu', 95, now, 'foreign'),
      sample('heartbeat', now, now, 'v', 'a', 'foreign'),
    ]);
    const result = await service.current('o', 'v');
    expect(result.status).toBe('DISCONNECTED');
    expect(result.metrics.cpu).toBeNull();
    expect(result.lastSeenAt).toBeNull();
  });
  it('uses actual source heartbeat, seven day lastSeen, never vector evaluation time', async () => {
    const { service, provider } = setup();
    provider.query.mockImplementation(async (q) =>
      q.includes('[7d:60s]')
        ? [sample('heartbeat', now - 3600)]
        : q.includes('"__ops_metric", "heartbeat"')
          ? [sample('cpu', now - 301), sample('heartbeat', now - 301)]
          : [sample('cpu', 95)],
    );
    const result = await service.current('o', 'v');
    expect(result.status).toBe('DISCONNECTED');
    expect(result.metrics.cpu).toBeNull();
    expect(result.sampledAt).toBeNull();
    expect(result.lastSeenAt).toBe(new Date((now - 301) * 1000).toISOString());
    provider.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([sample('heartbeat', now - 3600)]);
    vi.spyOn(Date, 'now').mockReturnValue((now + 31) * 1000);
    expect((await service.current('o', 'v')).lastSeenAt).toBe(
      new Date((now - 3600) * 1000).toISOString(),
    );
  });
  it.each([301, 290])(
    'does not let a %i-second-old memory heartbeat suppress fresher CPU and load',
    async (memoryAge) => {
      const { service, provider } = setup();
      provider.query.mockImplementation(async (q) =>
        q.includes('"__ops_metric", "heartbeat"')
          ? [
              sample('cpu', now - 1),
              sample('load', now - 1),
              sample('memory', now - 301),
              sample('heartbeat', now - memoryAge),
            ]
          : [sample('cpu', 96), sample('load', 1), sample('memory', 95)],
      );
      expect(await service.current('o', 'v')).toMatchObject({
        status: 'CRITICAL',
        sampledAt: new Date((now - 1) * 1000).toISOString(),
        lastSeenAt: new Date((now - 1) * 1000).toISOString(),
        metrics: { cpu: 96, load: 1, memory: null },
      });
    },
  );
  it('uses fresh CPU when memory total and heartbeat are absent without inventing memory', async () => {
    const { service, provider } = setup();
    provider.query.mockImplementation(async (q) =>
      q.includes('"__ops_metric", "heartbeat"') ? [sample('cpu', now - 1)] : [sample('cpu', 96)],
    );
    expect(await service.current('o', 'v')).toMatchObject({
      status: 'CRITICAL',
      sampledAt: new Date((now - 1) * 1000).toISOString(),
      lastSeenAt: new Date((now - 1) * 1000).toISOString(),
      metrics: { cpu: 96, memory: null },
    });
    expect(provider.query).toHaveBeenCalledTimes(2);
  });
  it('recomputes source freshness on cached values and singles concurrent requests', async () => {
    const { service, provider } = setup();
    provider.query.mockImplementation(async (q) =>
      q.includes('"__ops_metric", "heartbeat"')
        ? [
            sample('cpu', now - 300),
            sample('memory', now - 300),
            sample('heartbeat', now - 300),
          ]
        : [sample('cpu', 0), sample('memory', 85)],
    );
    const results = await Promise.all([
      service.current('o', 'v'),
      service.current('o', 'v'),
    ]);
    expect(results[0].status).toBe('WARNING');
    expect(provider.query).toHaveBeenCalledTimes(2);
    vi.spyOn(Date, 'now').mockReturnValue((now + 1) * 1000);
    expect((await service.current('o', 'v')).status).toBe('DISCONNECTED');
    expect(provider.query).toHaveBeenCalledTimes(2);
  });
  it('batches a page with fixed request count, exact pair matching, and isolates re-enrollment', async () => {
    const { service, provider, repo } = setup();
    const rows = await service.enrichPage('o', [vm(), vm('v2', 'a2')]);
    expect(rows[0].metrics.cpu).toBe(0);
    expect(rows[1].metrics.cpu).toBeNull();
    expect(provider.query).toHaveBeenCalledTimes(3);
    repo.getById.mockResolvedValue(vm('v', 'new'));
    expect((await service.current('o', 'v')).metrics.cpu).toBeNull();
    expect(provider.query).toHaveBeenCalledTimes(6);
  });
  it('ignores inactive/no agents, and inventory errors remain explicit with no cached failures', async () => {
    const { service, provider, repo } = setup();
    repo.getById.mockResolvedValue({ ...vm(), agent: null });
    expect((await service.current('o', 'v')).status).toBe('DISCONNECTED');
    expect(provider.query).not.toHaveBeenCalled();
    expect(
      (
        await service.enrichPage('o', [
          { ...vm(), agent: { ...vm().agent!, status: 'REVOKED' } },
        ])
      )[0].metricsState,
    ).toBe('empty');
    provider.query.mockRejectedValue(
      new ServiceUnavailableException({
        code: 'METRICS_DISABLED',
        message: 'secret',
      }),
    );
    expect((await service.enrichPage('o', [vm()]))[0].metricsState).toBe(
      'disabled',
    );
    provider.query.mockRejectedValue(new Error('secret'));
    expect((await service.enrichPage('o', [vm()]))[0].metricsState).toBe(
      'unavailable',
    );
    repo.getById.mockResolvedValue(vm());
    await expect(service.current('o', 'v')).rejects.toMatchObject({
      response: { code: 'METRICS_UNAVAILABLE' },
    });
  });
  it('rejects multiple matching aggregate series rather than merging disjoint timestamps', async () => {
    const { service, provider } = setup();
    provider.queryRange.mockResolvedValue(
      [0, 1000].map((offset) => ({
        labels: sample('cpu', 0).labels,
        values: Array.from({ length: 1000 }, (_, i) => ({
          timestamp: now - 3600 + offset + i,
          value: 1,
        })),
      })),
    );
    await expect(
      service.range('o', 'v', { range: '1h' }),
    ).rejects.toMatchObject({ response: { code: 'METRICS_UNAVAILABLE' } });
  });
  it('ignores off-grid timestamps and bounds normalized series to the requested grid', async () => {
    const { service, provider } = setup();
    provider.queryRange.mockResolvedValue([
      {
        labels: sample('cpu', 0).labels,
        values: Array.from({ length: 1000 }, (_, i) => ({
          timestamp: now - 3600 + i,
          value: 1,
        })),
      },
    ]);
    const result = await service.range('o', 'v', { range: '1h' });
    for (const points of Object.values(result.series)) {
      expect(points.length).toBeLessThanOrEqual(61);
      expect(points.length).toBe(17);
      for (const point of points)
        expect((Date.parse(point.timestamp) / 1000 - (now - 3600)) % 60).toBe(
          0,
        );
    }
  });
  it('canonicalizes negligible floating point drift to an explicit fractional start grid', async () => {
    const { service, provider } = setup();
    const from = now - 60 + 0.25;
    provider.queryRange.mockResolvedValue([
      {
        labels: sample('cpu', 0).labels,
        values: [
          { timestamp: from + 0.000001, value: 0 },
          { timestamp: from + 30 - 0.000001, value: 1 },
          { timestamp: from + 30.1, value: 99 },
        ],
      },
    ]);
    expect(
      (await service.range('o', 'v', { from, to: from + 60, step: 30 })).series
        .cpu,
    ).toEqual([
      { timestamp: new Date(from * 1000).toISOString(), value: 0 },
      { timestamp: new Date((from + 30) * 1000).toISOString(), value: 1 },
    ]);
  });
  it.each([
    ['1h', 1799996400, 1800000000, 60],
    ['6h', 1799978400, 1800000000, 60],
    ['24h', 1799913600, 1800000000, 300],
    ['7d', 1799395200, 1800000000, 1800],
  ] as const)(
    'retains epoch-aligned AMP history at a shifted polling time for %s',
    async (range, from, to, step) => {
      const { service, provider } = setup();
      vi.spyOn(Date, 'now').mockReturnValue((now + 30) * 1000);
      provider.queryRange.mockResolvedValue([
        {
          labels: sample('cpu', 0).labels,
          values: [
            { timestamp: now - step, value: 0 },
            { timestamp: now, value: null },
          ],
        },
        {
          labels: sample('cpu', 0, now, 'foreign').labels,
          values: [{ timestamp: now, value: 99 }],
        },
      ]);
      const result = await service.range('o', 'v', { range });
      expect(result).toMatchObject({
        from: new Date(from * 1000).toISOString(),
        to: new Date(to * 1000).toISOString(),
        step,
      });
      for (const points of Object.values(result.series)) {
        expect(points).toEqual([
          { timestamp: new Date((now - step) * 1000).toISOString(), value: 0 },
          { timestamp: new Date(now * 1000).toISOString(), value: null },
        ]);
      }
    },
  );
  it('retains real AMP epoch timestamps inside exact shifted explicit bounds', async () => {
    const { service, provider } = setup();
    provider.queryRange.mockResolvedValue([
      {
        labels: sample('cpu', 0).labels,
        values: [
          { timestamp: 1791543900, value: 52.281543322340355 },
          { timestamp: 1791541860, value: 45.16823873988146 },
          { timestamp: 1791541920, value: 0 },
          { timestamp: 1791541980, value: null },
          { timestamp: 1791541861, value: 99 },
          { timestamp: 1791540300, value: 99 },
          { timestamp: 1791543960, value: 99 },
        ],
      },
      {
        labels: sample('cpu', 0, now, 'v', 'old').labels,
        values: [{ timestamp: 1791541890, value: 99 }],
      },
    ]);
    const result = await service.range('o', 'v', {
      from: 1791540330,
      to: 1791543930,
      step: 60,
    });
    expect(result.from).toBe('2026-10-09T10:05:30.000Z');
    expect(result.to).toBe('2026-10-09T11:05:30.000Z');
    expect(result.step).toBe(60);
    expect(result.series.cpu).toEqual([
      { timestamp: '2026-10-09T10:31:00.000Z', value: 45.16823873988146 },
      { timestamp: '2026-10-09T10:32:00.000Z', value: 0 },
      { timestamp: '2026-10-09T10:33:00.000Z', value: null },
      { timestamp: '2026-10-09T11:05:00.000Z', value: 52.281543322340355 },
    ]);
  });
  it('rejects a provider mixing requested and epoch phases instead of merging them', async () => {
    const { service, provider } = setup();
    provider.queryRange.mockResolvedValue([
      {
        labels: sample('cpu', 0).labels,
        values: [
          { timestamp: 1791540330, value: 0 },
          { timestamp: 1791540360, value: 1 },
        ],
      },
    ]);
    await expect(
      service.range('o', 'v', { from: 1791540330, to: 1791543930, step: 60 }),
    ).rejects.toMatchObject({ response: { code: 'METRICS_UNAVAILABLE' } });
  });
  it('keeps duplicate epoch timestamps ambiguous rather than selecting a value', async () => {
    const { service, provider } = setup();
    provider.queryRange.mockResolvedValue([
      {
        labels: sample('cpu', 0).labels,
        values: [
          { timestamp: 1791541860, value: 0 },
          { timestamp: 1791541860.000001, value: 1 },
        ],
      },
    ]);
    expect(
      (
        await service.range('o', 'v', {
          from: 1791540330,
          to: 1791543930,
          step: 60,
        })
      ).series.cpu,
    ).toEqual([{ timestamp: '2026-10-09T10:31:00.000Z', value: null }]);
  });
  it.each([
    [0.25, 1000, 0.25, 999.25],
    [0, 999, 1, 999],
  ])(
    'bounds a near-limit explicit provider grid starting at %s',
    async (providerStart, count, first, last) => {
      const { service, provider } = setup();
      provider.queryRange.mockResolvedValue([
        {
          labels: sample('cpu', 0).labels,
          values: Array.from({ length: 1000 }, (_, i) => ({
            timestamp: providerStart + i,
            value: 0,
          })),
        },
      ]);
      const result = await service.range('o', 'v', {
        from: 0.25,
        to: 999.25,
        step: 1,
      });
      expect(result.series.cpu).toHaveLength(count);
      expect(result.series.cpu[0]).toEqual({
        timestamp: new Date(first * 1000).toISOString(),
        value: 0,
      });
      expect(result.series.cpu.at(-1)).toEqual({
        timestamp: new Date(last * 1000).toISOString(),
        value: 0,
      });
    },
  );
  it('returns no fabricated epoch point when a short explicit window contains none', async () => {
    const { service, provider } = setup();
    provider.queryRange.mockResolvedValue([
      {
        labels: sample('cpu', 0).labels,
        values: [
          { timestamp: 1791540300, value: 1 },
          { timestamp: 1791540360, value: 1 },
        ],
      },
    ]);
    expect(
      (
        await service.range('o', 'v', {
          from: 1791540330,
          to: 1791540331,
          step: 60,
        })
      ).series.cpu,
    ).toEqual([]);
  });
  it('normalizes range series with gaps, exact labels, sorting and zero', async () => {
    const { service, provider } = setup();
    provider.queryRange.mockResolvedValue([
      {
        labels: sample('cpu', 0).labels,
        values: [
          { timestamp: now - 60, value: 0 },
          { timestamp: now, value: null },
        ],
      },
      {
        labels: sample('cpu', 0, now, 'v', 'old').labels,
        values: [{ timestamp: now, value: 99 }],
      },
    ]);
    const result = await service.range('o', 'v', { range: '1h' });
    expect(result.step).toBe(60);
    expect(result.series.cpu).toEqual([
      { timestamp: new Date((now - 60) * 1000).toISOString(), value: 0 },
      { timestamp: new Date(now * 1000).toISOString(), value: null },
    ]);
    expect(provider.queryRange).toHaveBeenCalledTimes(6);
  });
});
