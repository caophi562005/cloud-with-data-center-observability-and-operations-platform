import { apiFetch } from "../../../lib/api/http-client";
import { ApiError, isApiError } from "../../../lib/api/api-error";
import type { IntegrationHistoryInput, IntegrationMetricsCurrent, IntegrationMetricsHistory } from "../integration-metrics.types";

const metricsPath = (org: string, vm: string, instance: string) =>
  `/api/v1/organizations/${encodeURIComponent(org)}/vms/${encodeURIComponent(vm)}/integrations/${encodeURIComponent(instance)}/metrics`;
async function metricsRequest<T>(path: string, signal?: AbortSignal): Promise<T> {
  try { return await apiFetch<T>(path, { method: "GET", cache: "no-store", signal, headers: { Accept: "application/json" } }); }
  catch (error) { throw ApiError.generic(isApiError(error) ? error.statusCode : 0); }
}
export function getIntegrationCurrentMetrics(org: string, vmId: string, instanceId: string, signal?: AbortSignal): Promise<IntegrationMetricsCurrent> {
  // Current accepts an empty query, not the history metric/entity selectors.
  return metricsRequest(`${metricsPath(org, vmId, instanceId)}/current`, signal);
}
export function getIntegrationMetricsHistory(org: string, vmId: string, instanceId: string, input: IntegrationHistoryInput, signal?: AbortSignal): Promise<IntegrationMetricsHistory> {
  const query = new URLSearchParams({ range: input.range, metric: input.metric });
  if (input.entity) query.set("entity", input.entity);
  return metricsRequest(`${metricsPath(org, vmId, instanceId)}/range?${query}`, signal);
}
