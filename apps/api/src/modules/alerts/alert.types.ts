export const alertNames = ['VMHighCPU', 'VMHighMemory', 'VMDiskUsageHigh', 'VMDisconnected'] as const;
export type CanonicalAlertEvent = Readonly<{
  source: 'metrics-primary'; fingerprint: string;
  status: 'FIRING' | 'RESOLVED'; organizationId: string; vmId: string;
  alertName: (typeof alertNames)[number]; severity: 'WARNING' | 'CRITICAL';
  startsAt: string; endsAt: string | null;
  labels: Readonly<Record<'organization_id' | 'vm_id' | 'alertname' | 'severity', string>>;
  annotations: Readonly<Partial<Record<'summary' | 'description', string>>>;
}>;
export type AlertBatchResult = { created: number; resolved: number; unchanged: number; metadataUpdated: number };
export type AlertTransition = { kind: 'INSERT' | 'UPDATE' | 'NOOP'; event: CanonicalAlertEvent };

// Never attach original payloads, SDK errors, database details or exception causes.
export class AlertInputError extends Error {
  constructor() { super('Invalid alert input'); }
}
export class AlertUnavailableError extends Error {
  constructor() { super('Alert ingestion unavailable'); }
}
export class SnsSignatureError extends Error {
  constructor() { super('SNS verification failed'); }
}
