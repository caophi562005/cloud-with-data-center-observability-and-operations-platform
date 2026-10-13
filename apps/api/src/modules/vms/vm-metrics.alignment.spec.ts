import { afterEach, describe, expect, it, vi } from 'vitest';
import { MetricsQueryClient } from '../../infrastructure/metrics/metrics-query.client.js';
import { VmMetricsService } from './vm-metrics.service.js';
import { VmsRepository } from './vms.repository.js';
import type { VmRecord } from './vms.types.js';
import type { VmMetricsQuery } from './schemas/vm-metrics.schema.js';

// Keep HTTP parsing and range processing real; replace only the external fetch/DB boundaries.
const record: VmRecord = {
  id: 'v',
  organizationId: 'o',
  hostname: 'vm',
  ipAddress: null,
  os: 'Linux',
  status: 'DISCONNECTED',
  tags: [],
  createdAt: new Date(0),
  updatedAt: new Date(0),
  agent: {
    id: 'a',
    status: 'ACTIVE',
    enrolledAt: new Date(0),
    lastSeenAt: null,
  },
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('portable range alignment through the real query client', () => {
  it.each([
    ['1h', 1791540300, 1791543900, 60],
    ['6h', 1791522300, 1791543900, 60],
    ['24h', 1791457500, 1791543900, 300],
    ['7d', 1790938800, 1791543600, 1800],
  ] as const)(
    'sends step-aligned %s bounds and keeps real epoch history',
    async (range, from, to, step) => {
      vi.spyOn(Date, 'now').mockReturnValue(1791543930750);
      const { service, requests } = setup([[to, '0']]);
      const result = await service.range('o', 'v', { range });
      expect(result.from).toBe(new Date(from * 1000).toISOString());
      expect(result.to).toBe(new Date(to * 1000).toISOString());
      expect(result.series.cpu).toEqual([
        { timestamp: new Date(to * 1000).toISOString(), value: 0 },
      ]);
      expect(requests).toHaveLength(6);
      for (const url of requests) {
        expect(url.pathname).toBe('/workspaces/test/api/v1/query_range');
        expect(url.searchParams.get('start')).toBe(String(from));
        expect(url.searchParams.get('end')).toBe(String(to));
        expect(url.searchParams.get('step')).toBe(String(step));
      }
    },
  );
  it.each([
    [
      { from: 59.9995, to: 179.9995, step: 60 },
      [
        [60, '0'],
        [120, '1'],
        [180, '99'],
      ],
      [
        { timestamp: '1970-01-01T00:01:00.000Z', value: 0 },
        { timestamp: '1970-01-01T00:02:00.000Z', value: 1 },
      ],
    ],
    [
      { from: 60.0005, to: 180.0005, step: 60 },
      [
        [60, '99'],
        [120, '0'],
        [180, '1'],
      ],
      [
        { timestamp: '1970-01-01T00:02:00.000Z', value: 0 },
        { timestamp: '1970-01-01T00:03:00.000Z', value: 1 },
      ],
    ],
    [
      { from: 60.0005, to: 180.0005, step: 60 },
      [
        [60.0005, '0'],
        [120.0005, '1'],
      ],
      [
        { timestamp: new Date(60.0005 * 1000).toISOString(), value: 0 },
        { timestamp: new Date(120.0005 * 1000).toISOString(), value: 1 },
      ],
    ],
  ] satisfies [
    VmMetricsQuery,
    [number, string][],
    { timestamp: string; value: number }[],
  ][])(
    'never shifts exact known-grid samples across a sub-millisecond phase for %j',
    async (query, values, expected) => {
      const { service } = setup(values);
      expect((await service.range('o', 'v', query)).series.cpu).toEqual(
        expected,
      );
    },
  );
  it.each([
    [{ from: 59.9995, to: 179.9995, step: 60 }, 119.99975],
    [{ from: 59.9985, to: 179.9985, step: 60 }, 119.99925],
  ] satisfies [VmMetricsQuery, number][])(
    'fails closed when numeric drift fits two distinct known grids for %j',
    async (query, timestamp) => {
      const { service } = setup([[timestamp, '1']]);
      await expect(service.range('o', 'v', query)).rejects.toMatchObject({
        response: { code: 'METRICS_UNAVAILABLE' },
      });
    },
  );
  it.each([
    [
      { from: 1791540330, to: 1791543930, step: 60 },
      [
        [1791541860, '45.16823873988146'],
        [1791543900, '52.281543322340355'],
      ],
      [
        { timestamp: '2026-10-09T10:31:00.000Z', value: 45.16823873988146 },
        { timestamp: '2026-10-09T11:05:00.000Z', value: 52.281543322340355 },
      ],
    ],
    [
      { from: 1791540330.25, to: 1791543930.25, step: 60 },
      [[1791541890.25, '0']],
      [{ timestamp: '2026-10-09T10:31:30.250Z', value: 0 }],
    ],
  ] satisfies [
    VmMetricsQuery,
    [number, string][],
    { timestamp: string; value: number }[],
  ][])(
    'preserves exact explicit transport bounds for %j',
    async (query, values, expected) => {
      const { service, requests } = setup(values);
      expect((await service.range('o', 'v', query)).series.cpu).toEqual(
        expected,
      );
      for (const url of requests) {
        expect(url.searchParams.get('start')).toBe(String(query.from));
        expect(url.searchParams.get('end')).toBe(String(query.to));
        expect(url.searchParams.get('step')).toBe(String(query.step));
      }
    },
  );
});

function setup(values: [number, string][]) {
  const requests: URL[] = [];
  vi.stubGlobal('fetch', async (input: URL) => {
    requests.push(new URL(input));
    return new Response(
      JSON.stringify({
        status: 'success',
        data: {
          resultType: 'matrix',
          result: [
            {
              metric: { organization_id: 'o', vm_id: 'v', agent_id: 'a' },
              values,
            },
          ],
        },
      }),
      { status: 200 },
    );
  });
  const provider = new MetricsQueryClient({
    query: {
      baseUrl: 'http://127.0.0.1:8005/workspaces/test',
      auth: { mode: 'none' },
    },
  });
  const repo = { getById: async () => record };
  return {
    service: new VmMetricsService(repo as unknown as VmsRepository, provider),
    requests,
  };
}
