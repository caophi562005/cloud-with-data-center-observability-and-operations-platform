export type AlertSeverity = "WARNING" | "CRITICAL";
export type AlertSignalStatus = "FIRING" | "RESOLVED";
export type AlertWorkflowStatus = "OPEN" | "ACKNOWLEDGED";
export type AlertSort = "severity_desc" | "started_at_desc" | "started_at_asc";
export interface AlertSummary {
  id: string; organizationId: string; vmId: string; vmHostname: string;
  source: string; fingerprint: string; alertName: string; severity: AlertSeverity;
  signalStatus: AlertSignalStatus; workflowStatus: AlertWorkflowStatus;
  startsAt: string; endsAt: string | null;
  acknowledgedBy: string | null; acknowledgedAt: string | null;
  createdAt: string; updatedAt: string;
}
export interface AlertDetail extends AlertSummary {
  labels: Record<string, string>; annotations: Record<string, string>;
}
export type AlertEventType = "ALERT_FIRING" | "ACKNOWLEDGED" | "COMMENT_ADDED" | "ALERT_RESOLVED";
export interface AlertEvent {
  id: string; alertId: string; sequence: number; type: AlertEventType;
  actorId: string | null; message: string | null; sourceTimeKey: string | null; createdAt: string;
}
export interface AlertPage<T> { items: T[]; total: number; page: number; pageSize: number; }
export interface AlertListQuery {
  page: number; pageSize: number; signalStatus?: AlertSignalStatus;
  workflowStatus?: AlertWorkflowStatus; severity?: AlertSeverity; vmId?: string; q?: string; sort?: AlertSort;
}
export interface AlertListState {
  tab: "firing" | "history"; q: string; severity?: AlertSeverity;
  workflowStatus?: AlertWorkflowStatus; vmId?: string; sort: AlertSort; page: number; pageSize: number;
}
export interface AlertSelection { organizationId: string; alertId: string; }
export interface AlertRule {
  name: string; severity: AlertSeverity; promql: string; forSeconds: number; intervalSeconds: number; namespace: string; group: string; health: string; state: 'inactive' | 'pending' | 'firing' | 'unknown'; activeAlerts: number; lastEvaluation: string | null; labels: Record<string, string>; annotations: Record<string, string>;
}
export interface AlertRulesResponse { scope: 'SHARED_VM_RULES'; managedBy: 'Terraform / AWS AMP'; fetchedAt: string; items: AlertRule[]; }
