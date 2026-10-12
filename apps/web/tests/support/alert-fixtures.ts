import type { AlertDetail, AlertEvent } from "../../src/features/alerts/alert.types";
export const orgA = "761fc531-3ece-49e1-bf11-11841699544a";
export const orgB = "761fc531-3ece-49e1-bf11-11841699544b";
export const alertId = "11111111-1111-4111-8111-111111111111";
export function alertFixture(overrides: Partial<AlertDetail> = {}): AlertDetail {
  return {
    id: alertId, organizationId: orgA, vmId: "22222222-2222-4222-8222-222222222222", vmHostname: "edge-example",
    source: "metrics-primary", fingerprint: "fixture-fingerprint", alertName: "VMHighCPU", severity: "WARNING",
    signalStatus: "FIRING", workflowStatus: "OPEN", startsAt: "2026-10-10T00:00:00.123456789Z", endsAt: null,
    acknowledgedBy: null, acknowledgedAt: null, createdAt: "2026-10-10T00:01:00.000Z", updatedAt: "2026-10-10T00:01:00.000Z",
    labels: { organization_id: orgA }, annotations: { summary: "CPU is above threshold" }, ...overrides,
  };
}
export function eventFixture(overrides: Partial<AlertEvent> = {}): AlertEvent {
  return { id: "33333333-3333-4333-8333-333333333333", alertId, sequence: 1, type: "ALERT_FIRING", actorId: null,
    message: null, sourceTimeKey: "2026-10-10T00:00:00.123456789Z", createdAt: "2026-10-10T00:01:00.000Z", ...overrides };
}
