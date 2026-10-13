import { describe, expect, it } from 'vitest';
import {
  vmMetricsQuerySchema,
  resolveMetricsWindow,
} from './vm-metrics.schema.js';
describe('metrics windows', () => {
  it.each([
    ['1h', 996360, 999960, 60],
    ['6h', 978360, 999960, 60],
    ['24h', 913500, 999900, 300],
    ['7d', 394200, 999000, 1800],
  ])('bounds preset %s on its evaluation grid', (range, from, to, step) => {
    expect(
      resolveMetricsWindow(vmMetricsQuerySchema.parse({ range }), 1_000_000),
    ).toEqual({ from, to, step });
  });
  it.each([
    ['1h', 1791540300, 1791543900, 60],
    ['6h', 1791522300, 1791543900, 60],
    ['24h', 1791457500, 1791543900, 300],
    ['7d', 1790938800, 1791543600, 1800],
  ])(
    'aligns the observed shifted AMP window for %s without changing its span',
    (range, from, to, step) => {
      expect(
        resolveMetricsWindow(
          vmMetricsQuerySchema.parse({ range }),
          1791543930.75,
        ),
      ).toEqual({ from, to, step });
    },
  );
  it('preserves exact explicit bounds and fractional evaluation phase', () => {
    const query = vmMetricsQuerySchema.parse({
      from: 1791540330.25,
      to: 1791543930.25,
      step: 60,
    });
    expect(resolveMetricsWindow(query, 1791543930.75)).toEqual({
      from: 1791540330.25,
      to: 1791543930.25,
      step: 60,
    });
  });
  it('accepts ISO and Unix seconds, preserving exactly 1000 points', () => {
    expect(
      vmMetricsQuerySchema.parse({
        from: '1970-01-01T00:00:00Z',
        to: '999',
        step: '1',
      }),
    ).toEqual({ from: 0, to: 999, step: 1 });
  });
  it.each([
    {},
    { range: 'bad' },
    { range: '1h', from: '0' },
    { from: '0', to: '1000', step: '1' },
    { from: '100', to: '0', step: '60' },
    { from: '0', to: '604801', step: '1000' },
    { from: 'NaN', to: 'Infinity', step: '1' },
    { from: '0', to: '10', step: '0' },
    { from: '0', to: '10', step: '1.5' },
    { range: '1h', query: 'up' },
    { from: '2026-02-30T00:00:00Z', to: '2026-03-02T00:00:00Z', step: '60' },
  ])('rejects unsafe window %j', (query) =>
    expect(vmMetricsQuerySchema.safeParse(query).success).toBe(false),
  );
});
