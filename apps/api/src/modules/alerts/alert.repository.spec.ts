import { Prisma } from '@prisma/client';
import type { Alert } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../infrastructure/database/prisma/prisma.service.js';
import { AlertRepository } from './alert.repository.js';
import { occurrenceKey, occurrenceKeyFromIdentity } from './alert-lifecycle.js';
import type { CanonicalAlertEvent } from './alert.types.js';

const event: CanonicalAlertEvent = {
  source: 'metrics-primary',
  organizationId: '11111111-1111-4111-8111-111111111111',
  vmId: '22222222-2222-4222-8222-222222222222',
  fingerprint: 'fixture',
  alertName: 'VMHighCPU',
  severity: 'WARNING',
  status: 'FIRING',
  startsAt: '2026-10-10T00:00:00.123456789Z',
  endsAt: null,
  labels: {
    organization_id: '11111111-1111-4111-8111-111111111111',
    vm_id: '22222222-2222-4222-8222-222222222222',
    alertname: 'VMHighCPU',
    severity: 'warning',
  },
  annotations: {},
};
function fixture(initial: Alert | null = null) {
  let row = initial;
  const base: Alert = {
    id: '77777777-7777-4777-8777-777777777777',
    source: event.source,
    organizationId: event.organizationId,
    vmId: event.vmId,
    fingerprint: event.fingerprint,
    alertName: event.alertName,
    severity: event.severity,
    status: event.status,
    startsAt: new Date(event.startsAt),
    endsAt: null,
    startsAtKey: event.startsAt,
    endsAtKey: null,
    labels: { ...event.labels },
    annotations: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    workflowStatus: 'OPEN',
    acknowledgedBy: null,
    acknowledgedAt: null,
  };
  const createdEvents: Prisma.AlertEventUncheckedCreateInput[] = [];
  const tx = {
    $queryRaw: vi
      .fn<(query: Prisma.Sql) => Promise<unknown[]>>()
      .mockResolvedValue([]),
    organization: {
      findUnique: vi.fn().mockResolvedValue({ id: event.organizationId }),
    },
    vm: { findFirst: vi.fn().mockResolvedValue({ id: event.vmId }) },
    alert: {
      findUnique: vi.fn(async () => row),
      create: vi.fn(
        async (input: { data: Prisma.AlertUncheckedCreateInput }) => {
          row = { ...base, ...input.data } as Alert;
          return row;
        },
      ),
      update: vi.fn(
        async (input: { data: Prisma.AlertUncheckedUpdateInput }) => {
          row = { ...row, ...input.data } as Alert;
          return row;
        },
      ),
    },
    alertEvent: {
      findFirst: vi.fn(async () =>
        createdEvents.length ? { sequence: createdEvents.length } : null,
      ),
      create: vi.fn(
        async (input: { data: Prisma.AlertEventUncheckedCreateInput }) => {
          createdEvents.push(input.data);
          return input.data;
        },
      ),
    },
  };
  const transaction = vi.fn(
    async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
  );
  const repository = new AlertRepository({
    $transaction: transaction,
  } as unknown as PrismaService);
  return {
    repository,
    tx,
    transaction,
    base,
    events: createdEvents,
    get row() {
      return row;
    },
  };
}
describe('observed signal history transaction', () => {
  it('uses byte-identical canonical occurrence identity including nanoseconds', () => {
    expect(
      occurrenceKeyFromIdentity({ ...event, startsAtKey: event.startsAt }),
    ).toBe(occurrenceKey(event));
    expect(
      occurrenceKeyFromIdentity({ ...event, startsAtKey: event.startsAt }),
    ).not.toBe(
      occurrenceKeyFromIdentity({
        ...event,
        startsAtKey: '2026-10-10T00:00:00.123456790Z',
      }),
    );
  });
  it('inserts firing and its precise observed event under READ COMMITTED', async () => {
    const f = fixture();
    expect(await f.repository.persistBatch([event], Date.now() + 5000)).toEqual(
      { created: 1, resolved: 0, unchanged: 0, metadataUpdated: 0 },
    );
    expect(f.events).toEqual([
      expect.objectContaining({
        alertId: f.base.id,
        sequence: 1,
        type: 'ALERT_FIRING',
        actorId: null,
        message: null,
        sourceTimeKey: event.startsAt,
      }),
    ]);
    expect(f.transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      }),
    );
    expect(
      f.tx.$queryRaw.mock.calls.some(([query]) =>
        query.values.includes(occurrenceKey(event)),
      ),
    ).toBe(true);
  });
  it('records only resolution for a resolved-first insert', async () => {
    const f = fixture();
    const resolved = {
      ...event,
      status: 'RESOLVED' as const,
      endsAt: '2026-10-10T00:10:00.000000001Z',
    };
    await f.repository.persistBatch([resolved], Date.now() + 5000);
    expect(f.events).toEqual([
      expect.objectContaining({
        type: 'ALERT_RESOLVED',
        sourceTimeKey: resolved.endsAt,
      }),
    ]);
  });
  it('records only first resolution, preserves workflow and ignores repeat/late firing', async () => {
    const template = fixture().base;
    const f = fixture({
      ...template,
      workflowStatus: 'ACKNOWLEDGED',
      acknowledgedBy: template.id,
      acknowledgedAt: new Date('2026-10-10T00:05:00Z'),
    });
    const resolved = {
      ...event,
      status: 'RESOLVED' as const,
      endsAt: '2026-10-10T00:10:00.000000001Z',
    };
    expect(
      (await f.repository.persistBatch([resolved], Date.now() + 5000)).resolved,
    ).toBe(1);
    expect(
      (await f.repository.persistBatch([resolved], Date.now() + 5000))
        .unchanged,
    ).toBe(1);
    expect(
      (await f.repository.persistBatch([event], Date.now() + 5000)).unchanged,
    ).toBe(1);
    expect(f.events).toHaveLength(1);
    expect(f.events[0]?.type).toBe('ALERT_RESOLVED');
    expect(f.row).toMatchObject({
      status: 'RESOLVED',
      workflowStatus: 'ACKNOWLEDGED',
      acknowledgedBy: template.id,
      acknowledgedAt: new Date('2026-10-10T00:05:00Z'),
    });
  });
  it('does not fabricate legacy history on unchanged or annotation-only replay', async () => {
    const f = fixture(fixture().base);
    expect(
      (await f.repository.persistBatch([event], Date.now() + 5000)).unchanged,
    ).toBe(1);
    expect(
      (
        await f.repository.persistBatch(
          [{ ...event, annotations: { summary: 'new' } }],
          Date.now() + 5000,
        )
      ).metadataUpdated,
    ).toBe(1);
    expect(f.events).toHaveLength(0);
  });
  it('awaits event persistence and translates failure without exposing the cause', async () => {
    const f = fixture();
    f.tx.alertEvent.create.mockRejectedValue(
      new Error('private event-write cause'),
    );
    await expect(
      f.repository.persistBatch([event], Date.now() + 5000),
    ).rejects.toThrow('Alert ingestion unavailable');
  });
  it('refuses exhausted per-alert sequence rather than wrapping', async () => {
    const f = fixture();
    f.tx.alertEvent.findFirst.mockResolvedValue({ sequence: 2_147_483_647 });
    await expect(
      f.repository.persistBatch([event], Date.now() + 5000),
    ).rejects.toThrow('Alert ingestion unavailable');
    expect(f.tx.alertEvent.create).not.toHaveBeenCalled();
  });
});
