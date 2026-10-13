import type { Alert, AlertEvent } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  toAlertSummary,
  toAlertDetail,
  toAlertEvent,
} from './alert-operations.dto.js';
const row: Alert & { vm: { hostname: string } } = {
  vm: { hostname: 'fixture-host' },
  id: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
  vmId: '33333333-3333-4333-8333-333333333333',
  source: 'metrics-primary',
  fingerprint: 'fixture',
  alertName: 'VMHighCPU',
  severity: 'WARNING',
  status: 'FIRING',
  workflowStatus: 'OPEN',
  acknowledgedBy: null,
  acknowledgedAt: null,
  startsAt: new Date('2026-10-10T00:00:00.123Z'),
  startsAtKey: '2026-10-10T00:00:00.123456789Z',
  endsAt: null,
  endsAtKey: null,
  labels: { organization_id: 'fixture' },
  annotations: { summary: 'plain text' },
  createdAt: new Date('2026-10-10T00:01:00Z'),
  updatedAt: new Date('2026-10-10T00:01:00Z'),
};
describe('explicit alert operator DTOs', () => {
  it('maps signal independently and uses precise source keys rather than Dates', () => {
    const result = toAlertSummary(row);
    expect(result).toMatchObject({
      id: row.id,
      signalStatus: 'FIRING',
      workflowStatus: 'OPEN',
      startsAt: row.startsAtKey,
      endsAt: null,
      acknowledgedBy: null,
      acknowledgedAt: null,
      createdAt: '2026-10-10T00:01:00.000Z',
    });
    for (const field of [
      'status',
      'startsAtKey',
      'endsAtKey',
      'labels',
      'annotations',
      'user',
    ])
      expect(result).not.toHaveProperty(field);
  });
  it('retains first actor/time for a resolved acknowledged detail without leaking a User', () => {
    const withExtra = {
      ...row,
      status: 'RESOLVED' as const,
      workflowStatus: 'ACKNOWLEDGED' as const,
      endsAt: new Date('2026-10-10T00:10:00Z'),
      endsAtKey: '2026-10-10T00:10:00.000000001Z',
      acknowledgedBy: row.id,
      acknowledgedAt: new Date('2026-10-10T00:05:00Z'),
      user: {
        email: 'do-not-expose@example.invalid',
        cognitoSub: 'private-sub',
      },
    };
    expect(toAlertDetail(withExtra)).toMatchObject({
      signalStatus: 'RESOLVED',
      workflowStatus: 'ACKNOWLEDGED',
      acknowledgedBy: row.id,
      acknowledgedAt: '2026-10-10T00:05:00.000Z',
      endsAt: withExtra.endsAtKey,
      labels: row.labels,
      annotations: row.annotations,
    });
    expect(toAlertDetail(withExtra)).not.toHaveProperty('user');
    expect(JSON.stringify(toAlertDetail(withExtra))).not.toContain(
      'private-sub',
    );
  });
  it('projects hostname additively in summaries and details but never exposes the VM relation', () => {
    const related = { ...row, vm: { hostname: 'edge-fixture' } };
    for (const result of [toAlertSummary(related), toAlertDetail(related)]) {
      expect(result).toHaveProperty('vmHostname', 'edge-fixture');
      expect(result).not.toHaveProperty('vm');
      expect(result.startsAt).toBe('2026-10-10T00:00:00.123456789Z');
    }
    expect(toAlertSummary(related)).not.toHaveProperty('annotations');
  });
  it('maps an event explicitly with null actor/message and precise source time', () => {
    const event: AlertEvent = {
      id: row.id,
      alertId: row.id,
      sequence: 1,
      type: 'ALERT_FIRING',
      actorId: null,
      message: null,
      sourceTimeKey: row.startsAtKey,
      createdAt: row.createdAt,
    };
    expect(toAlertEvent(event)).toEqual({
      ...event,
      createdAt: '2026-10-10T00:01:00.000Z',
    });
  });
});
