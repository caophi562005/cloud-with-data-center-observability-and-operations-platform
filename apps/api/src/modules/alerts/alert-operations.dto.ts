import type { AlertEvent, Prisma } from '@prisma/client';

const alertVmSelect = { hostname: true } satisfies Prisma.VmSelect;
export const alertDetailInclude = {
  vm: { select: alertVmSelect },
} satisfies Prisma.AlertInclude;
export type AlertDetailRow = Prisma.AlertGetPayload<{
  include: typeof alertDetailInclude;
}>;
export const alertSummarySelect = {
  vm: { select: alertVmSelect },
  id: true,
  source: true,
  organizationId: true,
  vmId: true,
  fingerprint: true,
  alertName: true,
  severity: true,
  status: true,
  workflowStatus: true,
  acknowledgedBy: true,
  acknowledgedAt: true,
  startsAtKey: true,
  endsAtKey: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.AlertSelect;
export type AlertSummaryRow = Prisma.AlertGetPayload<{
  select: typeof alertSummarySelect;
}>;
export function toAlertSummary(row: AlertSummaryRow) {
  return {
    id: row.id,
    source: row.source,
    organizationId: row.organizationId,
    vmId: row.vmId,
    vmHostname: row.vm.hostname,
    fingerprint: row.fingerprint,
    alertName: row.alertName,
    severity: row.severity,
    signalStatus: row.status,
    workflowStatus: row.workflowStatus,
    acknowledgedBy: row.acknowledgedBy,
    acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
    startsAt: row.startsAtKey,
    endsAt: row.endsAtKey,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
export function toAlertDetail(row: AlertDetailRow) {
  return {
    ...toAlertSummary(row),
    labels: row.labels,
    annotations: row.annotations,
  };
}
export function toAlertEvent(row: AlertEvent) {
  return {
    id: row.id,
    alertId: row.alertId,
    sequence: row.sequence,
    type: row.type,
    actorId: row.actorId,
    message: row.message,
    sourceTimeKey: row.sourceTimeKey,
    createdAt: row.createdAt.toISOString(),
  };
}
export type AlertSummaryDto = ReturnType<typeof toAlertSummary>;
export type AlertDetailDto = ReturnType<typeof toAlertDetail>;
export type AlertEventDto = ReturnType<typeof toAlertEvent>;
export type AlertPage<T> = {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
};
