import { apiFetch } from "../../../lib/api/http-client";
import { ApiError, isApiError } from "../../../lib/api/api-error";
import type { AgentStatusView, MonitoringCatalog, MonitoringConfigView, MonitoringSaveInput } from "../monitoring.types";

const orgPath = (org: string) => `/api/v1/organizations/${encodeURIComponent(org)}`;
const vmPath = (org: string, vm: string) => `${orgPath(org)}/vms/${encodeURIComponent(vm)}`;

// Never forward an API error body into a form or query error cache: a server error
// could echo input. Keep only HTTP status, with a fixed client-owned message.
async function monitoringRequest<T>(path: string, init: RequestInit): Promise<T> {
  try { return await apiFetch<T>(path, { ...init, cache: "no-store" }); }
  catch (error) { throw ApiError.generic(isApiError(error) ? error.statusCode : 0); }
}
export function getMonitoringCatalog(organizationId: string, signal?: AbortSignal): Promise<MonitoringCatalog> {
  return monitoringRequest(`${orgPath(organizationId)}/monitoring-catalog`, { method: "GET", signal, headers: { Accept: "application/json" } });
}
export function getVmMonitoringConfig(organizationId: string, vmId: string, signal?: AbortSignal): Promise<MonitoringConfigView> {
  return monitoringRequest(`${vmPath(organizationId, vmId)}/monitoring-config`, { method: "GET", signal, headers: { Accept: "application/json" } });
}
export function getAgentStatus(organizationId: string, vmId: string, signal?: AbortSignal): Promise<AgentStatusView> {
  return monitoringRequest(`${vmPath(organizationId, vmId)}/agent-status`, { method: "GET", signal, headers: { Accept: "application/json" } });
}
// Direct request, deliberately NOT a TanStack mutation: secret-bearing variables
// and request bodies must never enter MutationCache, even with gcTime: 0/reset.
export function saveVmMonitoringConfig(organizationId: string, vmId: string, input: MonitoringSaveInput, signal?: AbortSignal): Promise<MonitoringConfigView> {
  return monitoringRequest(`${vmPath(organizationId, vmId)}/monitoring-config`, {
    method: "PATCH", signal, headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
}
