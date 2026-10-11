import { apiFetch } from "../../../lib/api/http-client";
import type { AlertDetail, AlertEvent, AlertListQuery, AlertPage, AlertSummary, AlertRulesResponse } from "../alert.types";
export function getAlertRules(organizationId: string, signal?: AbortSignal): Promise<AlertRulesResponse> {
  return apiFetch(`/organizations/${encodeURIComponent(organizationId)}/alert-rules`, {signal});
}
function alertsPath(organizationId: string, alertId?: string): string {
  const base = `/organizations/${encodeURIComponent(organizationId)}/alerts`;
  return alertId === undefined ? base : `${base}/${encodeURIComponent(alertId)}`;
}
export function getAlerts(organizationId: string, query: AlertListQuery, signal?: AbortSignal): Promise<AlertPage<AlertSummary>> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
  return apiFetch(`${alertsPath(organizationId)}?${params}`, { signal });
}
export function getAlert(organizationId: string, alertId: string, signal?: AbortSignal): Promise<AlertDetail> {
  return apiFetch(alertsPath(organizationId, alertId), { signal });
}
export function getAlertEvents(organizationId: string, alertId: string, page: number, pageSize: number, signal?: AbortSignal): Promise<AlertPage<AlertEvent>> {
  return apiFetch(`${alertsPath(organizationId, alertId)}/events?${new URLSearchParams({ page: String(page), pageSize: String(pageSize) })}`, { signal });
}
export function acknowledgeAlert(organizationId: string, alertId: string): Promise<AlertDetail> {
  return apiFetch(`${alertsPath(organizationId, alertId)}/acknowledge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
}
export function addAlertComment(organizationId: string, alertId: string, message: string): Promise<AlertEvent> {
  return apiFetch(`${alertsPath(organizationId, alertId)}/comments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message }) });
}
