import type { Alert, AlertEvent } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { AlertService } from './alert.service.js';
import { AlertRepository } from './alert.repository.js';
const org = '11111111-1111-4111-8111-111111111111',
  id = '22222222-2222-4222-8222-222222222222',
  actor = '33333333-3333-4333-8333-333333333333';
const row: Alert & { vm: { hostname: string } } = {
  vm: { hostname: 'fixture-host' },
  id,
  organizationId: org,
  vmId: id,
  source: 'metrics-primary',
  fingerprint: 'fixture',
  alertName: 'VMHighCPU',
  severity: 'WARNING',
  status: 'RESOLVED',
  startsAt: new Date('2026-10-10T00:00:00Z'),
  startsAtKey: '2026-10-10T00:00:00.000000001Z',
  endsAt: new Date('2026-10-10T00:10:00Z'),
  endsAtKey: '2026-10-10T00:10:00.000000001Z',
  workflowStatus: 'OPEN',
  acknowledgedBy: null,
  acknowledgedAt: null,
  labels: {},
  annotations: {},
  createdAt: new Date('2026-10-10T00:01:00Z'),
  updatedAt: new Date('2026-10-10T00:01:00Z'),
};
const event: AlertEvent = {
  id,
  alertId: id,
  sequence: 1,
  type: 'COMMENT_ADDED',
  actorId: actor,
  message: 'note',
  sourceTimeKey: null,
  createdAt: row.createdAt,
};
function fixture() {
  const repository = {
    list: vi
      .fn<AlertRepository['list']>()
      .mockResolvedValue({ rows: [row], total: 1 }),
    get: vi.fn<AlertRepository['get']>().mockResolvedValue(row),
    events: vi
      .fn<AlertRepository['events']>()
      .mockResolvedValue({ rows: [event], total: 1 }),
    acknowledge: vi.fn<AlertRepository['acknowledge']>().mockResolvedValue({
      ...row,
      workflowStatus: 'ACKNOWLEDGED',
      acknowledgedBy: actor,
      acknowledgedAt: row.createdAt,
    }),
    comment: vi.fn<AlertRepository['comment']>().mockResolvedValue(event),
  };
  return {
    repository,
    service: new AlertService(repository as unknown as AlertRepository),
  };
}
describe('alert operations service', () => {
  it('maps a tenant-filtered summary page without labels or internal status', async () => {
    const f = fixture(),
      query = {
        page: 2,
        pageSize: 5,
        signalStatus: 'RESOLVED' as const,
        severity: 'WARNING' as const,
      };
    const result = await f.service.list(org, query);
    expect(f.repository.list).toHaveBeenCalledWith(org, query);
    expect(result).toMatchObject({
      page: 2,
      pageSize: 5,
      total: 1,
      items: [
        {
          signalStatus: 'RESOLVED',
          workflowStatus: 'OPEN',
          startsAt: row.startsAtKey,
        },
      ],
    });
    expect(result.items[0]).not.toHaveProperty('labels');
    expect(result.items[0]).not.toHaveProperty('status');
  });
  it('returns explicit detail and scoped ordered history pages', async () => {
    const f = fixture();
    expect(await f.service.get(org, id)).toMatchObject({
      labels: {},
      annotations: {},
      signalStatus: 'RESOLVED',
    });
    expect(
      await f.service.events(org, id, { page: 1, pageSize: 50 }),
    ).toMatchObject({
      page: 1,
      pageSize: 50,
      total: 1,
      items: [
        { type: 'COMMENT_ADDED', actorId: actor, message: 'note', sequence: 1 },
      ],
    });
    expect(f.repository.get).toHaveBeenCalledWith(org, id);
    expect(f.repository.events).toHaveBeenCalledWith(org, id, {
      page: 1,
      pageSize: 50,
    });
  });
  it.each(['get', 'events', 'acknowledge', 'comment'] as const)(
    'returns scoped safe not-found for absent parent: %s',
    async (method) => {
      const f = fixture();
      f.repository[method].mockResolvedValue(null);
      const operation =
        method === 'get'
          ? f.service.get(org, id)
          : method === 'events'
            ? f.service.events(org, id, { page: 1, pageSize: 50 })
            : method === 'acknowledge'
              ? f.service.acknowledge(org, id, actor)
              : f.service.comment(org, id, actor, { message: 'note' });
      await expect(operation).rejects.toMatchObject({
        code: 'RESOURCE_NOT_FOUND',
        status: 404,
      });
    },
  );
  it('returns the stored winner on resolved ACK and preserves a bounded service deadline', async () => {
    const f = fixture();
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      expect(await f.service.acknowledge(org, id, actor)).toMatchObject({
        signalStatus: 'RESOLVED',
        workflowStatus: 'ACKNOWLEDGED',
        acknowledgedBy: actor,
        acknowledgedAt: row.createdAt.toISOString(),
      });
      expect(f.repository.acknowledge).toHaveBeenCalledWith(
        org,
        id,
        actor,
        6000,
      );
    } finally {
      now.mockRestore();
    }
  });
  it('allows comments without prior ACK and after resolution; does not retry successful duplicate POSTs', async () => {
    const f = fixture();
    await f.service.comment(org, id, actor, { message: 'note' });
    await f.service.comment(org, id, actor, { message: 'note' });
    expect(f.repository.comment).toHaveBeenCalledTimes(2);
    expect(f.repository.comment).toHaveBeenCalledWith(
      org,
      id,
      actor,
      'note',
      expect.any(Number),
    );
  });
  it('rejects absent trusted actor before any persistence without falling back to a subject/body', async () => {
    const f = fixture();
    await expect(f.service.acknowledge(org, id, '')).rejects.toMatchObject({
      status: 401,
    });
    await expect(
      f.service.comment(org, id, '', { message: 'note' }),
    ).rejects.toMatchObject({ status: 401 });
    expect(f.repository.acknowledge).not.toHaveBeenCalled();
    expect(f.repository.comment).not.toHaveBeenCalled();
  });
  it.each(['list', 'get', 'events', 'acknowledge', 'comment'] as const)(
    'translates persistence failure to safe503 without raw details: %s',
    async (method) => {
      const f = fixture();
      f.repository[method].mockRejectedValue(new Error('private DB message'));
      const operation =
        method === 'list'
          ? f.service.list(org, { page: 1, pageSize: 50 })
          : method === 'get'
            ? f.service.get(org, id)
            : method === 'events'
              ? f.service.events(org, id, { page: 1, pageSize: 50 })
              : method === 'acknowledge'
                ? f.service.acknowledge(org, id, actor)
                : f.service.comment(org, id, actor, { message: 'note' });
      await expect(operation).rejects.toMatchObject({ status: 503 });
      await expect(operation).rejects.not.toThrow('private DB message');
    },
  );
});
