import { describe, expect, it } from 'vitest';
import { deriveVmHealth, VM_HEALTH_POLICY } from './vm-health.js';
const metrics = {
  cpu: null,
  memory: null,
  disk: null,
  networkRx: null,
  networkTx: null,
  load: null,
  uptimeHours: null,
};
describe('VM health', () => {
  it('accepts an operator-supplied policy rather than hard-coding MVP thresholds', () => {
    const policy = {
      ...VM_HEALTH_POLICY,
      staleSeconds: 60,
      cpuWarning: 50,
      critical: 75,
    };
    expect(
      deriveVmHealth({ ...metrics, cpu: 75 }, true, 1000, 1000, policy),
    ).toBe('CRITICAL');
    expect(
      deriveVmHealth({ ...metrics, cpu: 60 }, true, 1000, 1000, policy),
    ).toBe('WARNING');
    expect(
      deriveVmHealth({ ...metrics, cpu: 0 }, true, 939, 1000, policy),
    ).toBe('DISCONNECTED');
  });
  it.each(['memory', 'disk'] as const)(
    'uses exact %s warning and critical boundaries',
    (name) => {
      expect(
        deriveVmHealth({ ...metrics, [name]: 84.9 }, true, 1000, 1000),
      ).toBe('HEALTHY');
      expect(deriveVmHealth({ ...metrics, [name]: 85 }, true, 1000, 1000)).toBe(
        'WARNING',
      );
      expect(deriveVmHealth({ ...metrics, [name]: 95 }, true, 1000, 1000)).toBe(
        'CRITICAL',
      );
    },
  );
  it.each([
    [0, 'HEALTHY'],
    [79.9, 'HEALTHY'],
    [80, 'WARNING'],
    [94.9, 'WARNING'],
    [95, 'CRITICAL'],
  ])('derives CPU threshold %s as %s', (cpu, status) =>
    expect(
      deriveVmHealth({ ...metrics, cpu: Number(cpu) }, true, 700, 1000),
    ).toBe(status),
  );
  it('handles partial percent data, precedence, stale samples and inactive agent', () => {
    expect(
      deriveVmHealth({ ...metrics, memory: 85, disk: 95 }, true, 1000, 1000),
    ).toBe('CRITICAL');
    expect(deriveVmHealth({ ...metrics, cpu: 99 }, true, 699, 1000)).toBe(
      'DISCONNECTED',
    );
    expect(deriveVmHealth({ ...metrics, cpu: 0 }, false, 1000, 1000)).toBe(
      'DISCONNECTED',
    );
    expect(deriveVmHealth(metrics, true, null, 1000)).toBe('DISCONNECTED');
    expect(deriveVmHealth(metrics, true, 1000, 1000)).toBe('DISCONNECTED');
  });
});
