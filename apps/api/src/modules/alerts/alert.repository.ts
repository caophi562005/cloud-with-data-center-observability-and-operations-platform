import { Injectable } from '@nestjs/common';
import { Prisma, type AlertEvent, type AlertEventType } from '@prisma/client';
import type {
  AlertListQuery,
  AlertEventsQuery,
} from './schemas/alert-operations.schema.js';
import { PrismaService } from '../../infrastructure/database/prisma/prisma.service.js';
import {
  alertSummarySelect,
  alertDetailInclude,
  type AlertSummaryRow,
  type AlertDetailRow,
} from './alert-operations.dto.js';
import {
  occurrenceKey,
  occurrenceKeyFromIdentity,
  transitionOccurrence,
} from './alert-lifecycle.js';
import {
  AlertInputError,
  AlertUnavailableError,
  type AlertBatchResult,
  type CanonicalAlertEvent,
} from './alert.types.js';

function isExpectedRace(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === 'P2034') return true;
  if (error.code !== 'P2002') return false;
  const target = error.meta?.target;
  const fields = [
    'source',
    'organizationId',
    'vmId',
    'fingerprint',
    'startsAtKey',
  ];
  return (
    target === 'alerts_occurrence_key' ||
    (Array.isArray(target) &&
      target.length === fields.length &&
      fields.every((field) => target.includes(field)))
  );
}
@Injectable()
export class AlertRepository {
  constructor(private readonly prisma: PrismaService) {}

  private async read<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch {
      throw new AlertUnavailableError();
    }
  }
  async list(
    organizationId: string,
    query: AlertListQuery,
  ): Promise<{ rows: AlertSummaryRow[]; total: number }> {
    return this.read(async () => {
      // Prisma contains uses LIKE patterns; escape user metacharacters for literal substring search.
      const search = query.q?.replace(/[\\%_]/gu, '\\$&');
      const orderBy: Prisma.AlertOrderByWithRelationInput[] =
        query.sort === 'severity_desc'
          ? [{ severity: 'desc' }, { startsAtKey: 'desc' }, { id: 'desc' }]
          : query.sort === 'started_at_desc' || query.sort === 'started_at_asc'
            ? [
                {
                  startsAtKey: query.sort === 'started_at_asc' ? 'asc' : 'desc',
                },
                { id: 'desc' },
              ]
            : [{ createdAt: 'desc' }, { id: 'desc' }];
      const where: Prisma.AlertWhereInput = {
        organizationId,
        ...(search
          ? {
              OR: [
                { alertName: { contains: search, mode: 'insensitive' } },
                {
                  vm: {
                    is: {
                      organizationId,
                      hostname: { contains: search, mode: 'insensitive' },
                    },
                  },
                },
              ],
            }
          : {}),
        ...(query.signalStatus ? { status: query.signalStatus } : {}),
        ...(query.workflowStatus
          ? { workflowStatus: query.workflowStatus }
          : {}),
        ...(query.severity ? { severity: query.severity } : {}),
        ...(query.vmId ? { vmId: query.vmId } : {}),
      };
      const [rows, total] = await Promise.all([
        this.prisma.alert.findMany({
          where,
          select: alertSummarySelect,
          orderBy,
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        }),
        this.prisma.alert.count({ where }),
      ]);
      return { rows, total };
    });
  }
  async get(
    organizationId: string,
    id: string,
  ): Promise<AlertDetailRow | null> {
    return this.read(() =>
      this.prisma.alert.findFirst({
        where: { id, organizationId },
        include: alertDetailInclude,
      }),
    );
  }
  async events(
    organizationId: string,
    id: string,
    query: AlertEventsQuery,
  ): Promise<{ rows: AlertEvent[]; total: number } | null> {
    return this.read(async () => {
      if (
        !(await this.prisma.alert.findFirst({
          where: { id, organizationId },
          select: { id: true },
        }))
      )
        return null;
      const where: Prisma.AlertEventWhereInput = {
        alertId: id,
        alert: { organizationId },
      };
      const [rows, total] = await Promise.all([
        this.prisma.alertEvent.findMany({
          where,
          orderBy: { sequence: 'asc' },
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        }),
        this.prisma.alertEvent.count({ where }),
      ]);
      return { rows, total };
    });
  }
  private async mutate<T>(
    organizationId: string,
    id: string,
    deadlineAt: number,
    operation: (
      tx: Prisma.TransactionClient,
      row: AlertDetailRow,
    ) => Promise<T>,
  ): Promise<T | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const remaining = deadlineAt - Date.now();
      if (remaining < 300) throw new AlertUnavailableError();
      const maxWait = Math.min(1000, Math.floor(remaining / 4));
      const timeout = Math.min(3000, remaining - maxWait - 100);
      try {
        return await this.prisma.$transaction(
          async (tx) => {
            const budget = (): void => {
              if (Date.now() >= deadlineAt) throw new AlertUnavailableError();
            };
            await tx.$queryRaw(
              Prisma.sql`SELECT set_config('lock_timeout', ${`${Math.min(timeout, 1500)}ms`}, true), set_config('statement_timeout', ${`${timeout}ms`}, true)`,
            );
            // Preliminary lookup is itself inside the bounded transaction; no unbounded preflight read.
            const identity = await tx.alert.findFirst({
              where: { id, organizationId },
            });
            if (!identity) return null;
            budget();
            const key = occurrenceKeyFromIdentity(identity);
            await tx.$queryRaw(
              Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text`,
            );
            budget();
            const row = await tx.alert.findFirst({
              where: { id, organizationId },
              include: alertDetailInclude,
            });
            if (!row) return null;
            if (occurrenceKeyFromIdentity(row) !== key)
              throw new AlertUnavailableError();
            const result = await operation(tx, row);
            budget();
            return result;
          },
          {
            maxWait,
            timeout,
            isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          },
        );
      } catch (error) {
        // Retry only known rollback-guaranteed transaction races, never uncertain successful comments.
        if (isExpectedRace(error) && attempt < 2 && Date.now() < deadlineAt)
          continue;
        throw new AlertUnavailableError();
      }
    }
    throw new AlertUnavailableError();
  }
  async acknowledge(
    organizationId: string,
    id: string,
    actorUserId: string,
    deadlineAt: number,
  ): Promise<AlertDetailRow | null> {
    return this.mutate(organizationId, id, deadlineAt, async (tx, row) => {
      if (row.workflowStatus === 'ACKNOWLEDGED') return row;
      const acknowledged = await tx.alert.update({
        where: { id: row.id },
        include: alertDetailInclude,
        data: {
          workflowStatus: 'ACKNOWLEDGED',
          acknowledgedBy: actorUserId,
          acknowledgedAt: new Date(),
        },
      });
      await this.appendEvent(
        tx,
        row.id,
        'ACKNOWLEDGED',
        actorUserId,
        null,
        null,
      );
      return acknowledged;
    });
  }
  async comment(
    organizationId: string,
    id: string,
    actorUserId: string,
    message: string,
    deadlineAt: number,
  ): Promise<AlertEvent | null> {
    return this.mutate(organizationId, id, deadlineAt, (tx, row) =>
      this.appendEvent(tx, row.id, 'COMMENT_ADDED', actorUserId, message, null),
    );
  }

  // Call only while holding this alert's canonical occurrence lock.
  private async appendEvent(
    tx: Prisma.TransactionClient,
    alertId: string,
    type: AlertEventType,
    actorId: string | null,
    message: string | null,
    sourceTimeKey: string | null,
  ) {
    const latest = await tx.alertEvent.findFirst({
      where: { alertId },
      orderBy: { sequence: 'desc' },
      select: { sequence: true },
    });
    const sequence = (latest?.sequence ?? 0) + 1;
    if (
      !Number.isSafeInteger(sequence) ||
      sequence < 1 ||
      sequence > 2_147_483_647
    )
      throw new AlertUnavailableError();
    return tx.alertEvent.create({
      data: { alertId, sequence, type, actorId, message, sourceTimeKey },
    });
  }

  async persistBatch(
    events: readonly CanonicalAlertEvent[],
    deadlineAt: number,
  ): Promise<AlertBatchResult> {
    const ordered = [...events].sort((a, b) =>
      occurrenceKey(a) < occurrenceKey(b)
        ? -1
        : occurrenceKey(a) > occurrenceKey(b)
          ? 1
          : 0,
    );
    for (let attempt = 0; attempt < 3; attempt++) {
      const remaining = deadlineAt - Date.now();
      if (remaining < 300) throw new AlertUnavailableError();
      const maxWait = Math.min(1000, Math.floor(remaining / 4));
      const timeout = Math.min(3000, remaining - maxWait - 100);
      try {
        return await this.prisma.$transaction(
          async (tx) => {
            const budget = (): void => {
              if (Date.now() >= deadlineAt) throw new AlertUnavailableError();
            };
            await tx.$queryRaw(
              Prisma.sql`SELECT set_config('lock_timeout', ${`${Math.min(timeout, 1500)}ms`}, true), set_config('statement_timeout', ${`${timeout}ms`}, true)`,
            );
            for (const event of ordered) {
              budget();
              await tx.$queryRaw(
                Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${occurrenceKey(event)}, 0))::text`,
              );
            }
            // Validate every association before any write; FK remains authoritative
            // if a tenant/VM is deleted concurrently after this check.
            for (const event of ordered) {
              budget();
              const organization = await tx.organization.findUnique({
                where: { id: event.organizationId },
                select: { id: true },
              });
              const vm = await tx.vm.findFirst({
                where: { id: event.vmId, organizationId: event.organizationId },
                select: { id: true },
              });
              if (!organization || !vm) throw new AlertInputError();
            }
            const result: AlertBatchResult = {
              created: 0,
              resolved: 0,
              unchanged: 0,
              metadataUpdated: 0,
            };
            for (const event of ordered) {
              budget();
              const where = {
                source: event.source,
                organizationId: event.organizationId,
                vmId: event.vmId,
                fingerprint: event.fingerprint,
                startsAtKey: event.startsAt,
              };
              const row = await tx.alert.findUnique({
                where: {
                  source_organizationId_vmId_fingerprint_startsAtKey: where,
                },
              });
              const current: CanonicalAlertEvent | null = row
                ? {
                    source: 'metrics-primary',
                    organizationId: row.organizationId,
                    vmId: row.vmId,
                    fingerprint: row.fingerprint,
                    alertName:
                      row.alertName as CanonicalAlertEvent['alertName'],
                    severity: row.severity,
                    status: row.status,
                    startsAt: row.startsAtKey,
                    endsAt: row.endsAtKey,
                    labels: row.labels as CanonicalAlertEvent['labels'],
                    annotations:
                      row.annotations as CanonicalAlertEvent['annotations'],
                  }
                : null;
              const transition = transitionOccurrence(current, event);
              if (transition.kind === 'INSERT') {
                const created = await tx.alert.create({
                  data: {
                    ...where,
                    alertName: event.alertName,
                    severity: event.severity,
                    status: event.status,
                    startsAt: new Date(event.startsAt),
                    endsAt: event.endsAt ? new Date(event.endsAt) : null,
                    endsAtKey: event.endsAt,
                    labels: { ...event.labels },
                    annotations: { ...event.annotations },
                  },
                });
                await this.appendEvent(
                  tx,
                  created.id,
                  event.status === 'FIRING' ? 'ALERT_FIRING' : 'ALERT_RESOLVED',
                  null,
                  null,
                  event.status === 'FIRING' ? event.startsAt : event.endsAt,
                );
                result.created++;
              } else if (transition.kind === 'UPDATE' && row) {
                const next = transition.event;
                await tx.alert.update({
                  where: { id: row.id },
                  data: {
                    status: next.status,
                    endsAt: next.endsAt ? new Date(next.endsAt) : null,
                    endsAtKey: next.endsAt,
                    annotations: { ...next.annotations },
                  },
                });
                if (current?.status !== next.status) {
                  await this.appendEvent(
                    tx,
                    row.id,
                    'ALERT_RESOLVED',
                    null,
                    null,
                    next.endsAt,
                  );
                  result.resolved++;
                } else result.metadataUpdated++;
              } else result.unchanged++;
            }
            budget();
            return result;
          },
          {
            maxWait,
            timeout,
            isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          },
        );
      } catch (error) {
        if (error instanceof AlertInputError) throw error;
        if (isExpectedRace(error) && attempt < 2 && Date.now() < deadlineAt)
          continue;
        throw new AlertUnavailableError();
      }
    }
    throw new AlertUnavailableError();
  }
}
