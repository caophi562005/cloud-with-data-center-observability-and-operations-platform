import { describe, expect, it } from 'vitest';
import { MetricsQueryClient } from '../../infrastructure/metrics/metrics-query.client.js';
import { AlertRulesService } from './alert-rules.service.js';
const org = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
function rule(overrides: Record<string, unknown> = {}) {
  return {
    name: 'VMHighCPU',
    type: 'alerting',
    query: 'max by (organization_id, vm_id) (cpu_usage) > 80',
    duration: 300,
    labels: { severity: 'warning' },
    annotations: {
      summary: 'CPU usage is high',
      description: 'CPU high for five minutes',
    },
    health: 'ok',
    lastEvaluation: '2026-10-11T01:00:00.123456789Z',
    state: 'firing',
    alerts: [],
    ...overrides,
  };
}
function group(
  rules: unknown[] = [rule()],
  overrides: Record<string, unknown> = {},
) {
  return {
    name: 'opsgrid-vm-health',
    file: 'opsgrid-dev-vm-alerts',
    interval: 60,
    rules,
    ...overrides,
  };
}
function service(groups: unknown[]) {
  return new AlertRulesService({
    listRuleGroups: async () => groups,
  } as MetricsQueryClient);
}
describe('shared VM rule configuration and tenant-scoped evaluation', () => {
  it('includes actual fetch receipt time distinct from last evaluation', async () => {
    const before = Date.now();
    const response = await service([group()]).list(org);
    expect(response).toHaveProperty('fetchedAt');
    const fetched = new Date(
      (response as unknown as { fetchedAt: string }).fetchedAt,
    ).getTime();
    expect(fetched).toBeGreaterThanOrEqual(before);
    expect(fetched).toBeLessThanOrEqual(Date.now());
    expect(response.items[0].lastEvaluation).not.toEqual(
      (response as unknown as { fetchedAt: string }).fetchedAt,
    );
  });
  it('projects actual definition fields without global state or raw response fields', async () => {
    const result = await service([group()]).list(org);
    expect(result.scope).toBe('SHARED_VM_RULES');
    expect(result.managedBy).toBe('Terraform / AWS AMP');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      name: 'VMHighCPU',
      severity: 'WARNING',
      promql: rule().query,
      forSeconds: 300,
      intervalSeconds: 60,
      namespace: 'opsgrid-dev-vm-alerts',
      group: 'opsgrid-vm-health',
      health: 'ok',
      state: 'inactive',
      activeAlerts: 0,
      lastEvaluation: rule().lastEvaluation,
    });
    expect(result.items[0]).not.toHaveProperty('alerts');
    expect(result.items[0]).not.toHaveProperty('lastError');
  });
  it('never leaks foreign instances or treats workspace FIRING as current-tenant FIRING', async () => {
    const result = await service([
      group([
        rule({
          alerts: [
            {
              labels: {
                organization_id: other,
                vm_id: 'foreign-vm',
                secret: 'foreign-secret',
              },
              state: 'firing',
              activeAt: 'foreign-time',
              value: 'private-value',
            },
          ],
        }),
      ]),
    ]).list(org);
    expect(result.items[0]).toMatchObject({
      state: 'inactive',
      activeAlerts: 0,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /foreign|private-value|22222222/,
    );
  });
  it('computes pending then firing solely from own instances', async () => {
    const own = { labels: { organization_id: org }, state: 'pending' };
    expect(
      (await service([group([rule({ alerts: [own] })])]).list(org)).items[0],
    ).toMatchObject({ state: 'pending', activeAlerts: 1 });
    expect(
      (
        await service([
          group([
            rule({
              alerts: [
                own,
                { ...own, state: 'firing' },
                { labels: { organization_id: other }, state: 'firing' },
              ],
            }),
          ]),
        ]).list(org)
      ).items[0],
    ).toMatchObject({ state: 'firing', activeAlerts: 2 });
  });
  it('filters other namespace/group/name configurations before projecting fields', async () => {
    const result = await service([
      group([
        rule({ name: 'PrivateOtherRule', query: 'private-tenant-expression' }),
      ]),
      group([rule()], { file: 'private-namespace' }),
      group([rule()], { name: 'private-group' }),
    ]).list(org);
    expect(result.items).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('returns all four supported actual definitions, critical first and stable name order', async () => {
    const result = await service([
      group(
        ['VMHighMemory', 'VMDisconnected', 'VMHighCPU', 'VMDiskUsageHigh'].map(
          (name) =>
            rule({
              name,
              labels: {
                severity: name === 'VMDisconnected' ? 'critical' : 'warning',
              },
            }),
        ),
      ),
    ]).list(org);
    expect(result.items.map((item) => item.name)).toEqual([
      'VMDisconnected',
      'VMDiskUsageHigh',
      'VMHighCPU',
      'VMHighMemory',
    ]);
  });
  it('does not label unhealthy evaluation as inactive', async () => {
    expect(
      (
        await service([
          group([rule({ health: 'err', lastError: 'private-provider-error' })]),
        ]).list(org)
      ).items[0],
    ).toMatchObject({ health: 'err', state: 'unknown' });
  });
  it('does not expose arbitrary definition labels/annotations', async () => {
    const result = await service([
      group([
        rule({
          labels: { severity: 'warning', internal: 'private-label' },
          annotations: {
            summary: 'Shared summary',
            description: 'Shared description',
            internal: 'private-annotation',
          },
        }),
      ]),
    ]).list(org);
    expect(result.items[0]?.labels).toEqual({ severity: 'warning' });
    expect(result.items[0]?.annotations).toEqual({
      summary: 'Shared summary',
      description: 'Shared description',
    });
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it.each([
    { query: 1 },
    { duration: -1 },
    { labels: { severity: 'fatal' } },
    { alerts: [{ labels: {}, state: 'weird' }] },
    { lastEvaluation: 'not-time' },
  ])('fails closed for malformed supported rule %j', async (bad) => {
    await expect(service([group([rule(bad)])]).list(org)).rejects.toMatchObject(
      { reason: 'invalid_response' },
    );
  });
  it('fails closed for duplicate supported definitions', async () => {
    await expect(
      service([group([rule(), rule()])]).list(org),
    ).rejects.toMatchObject({ reason: 'invalid_response' });
  });
  it('returns truthful empty when shared group is absent', async () => {
    expect((await service([]).list(org)).items).toEqual([]);
  });
});
