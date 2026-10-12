import type { AlertListState, AlertSelection } from "../alert.types";
import { isAlertId } from "../hooks/use-alerts";
function integer(value: string | null, max: number, fallback: number): number {
  if (!value || !/^[1-9]\d*$/.test(value)) return fallback;
  const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed <= max ? parsed : fallback;
}
export function readAlertListState(params: URLSearchParams): AlertListState {
  const q = params.get("q")?.trim() ?? "";
  const severity = params.get("severity"), workflowStatus = params.get("workflowStatus"), vmId = params.get("vmId"), sort = params.get("sort");
  const pageSize = integer(params.get("pageSize"), 100, 50);
  return { tab: params.get("tab") === "history" ? "history" : "firing", q: q.length <= 120 ? q : "", page: integer(params.get("page"), Math.floor(2147483647 / pageSize), 1), pageSize,
    sort: sort === "started_at_asc" || sort === "started_at_desc" ? sort : "severity_desc",
    ...(severity === "WARNING" || severity === "CRITICAL" ? { severity } : {}), ...(workflowStatus === "OPEN" || workflowStatus === "ACKNOWLEDGED" ? { workflowStatus } : {}),
    ...(isAlertId(vmId) ? { vmId: vmId! } : {}) };
}
export function patchAlertListState(params: URLSearchParams, patch: Partial<AlertListState>): URLSearchParams {
  const next = new URLSearchParams(params);
  const filterChanged = Object.keys(patch).some((key) => key !== "page");
  for (const [key, value] of Object.entries(patch)) { if (value === undefined || value === "") next.delete(key); else next.set(key, String(value)); }
  if (filterChanged && patch.page === undefined) next.set("page", "1");
  return next;
}
export function readAlertSelection(params: URLSearchParams): AlertSelection | null {
  const organizationId = params.get("alertOrganizationId"), alertId = params.get("alertId");
  return isAlertId(organizationId) && isAlertId(alertId) ? { organizationId: organizationId!, alertId: alertId! } : null;
}
export function patchAlertSelection(params: URLSearchParams, selection: AlertSelection | null): URLSearchParams {
  const next = new URLSearchParams(params); next.delete("alertId"); next.delete("alertOrganizationId");
  if (selection) { next.set("alertId", selection.alertId); next.set("alertOrganizationId", selection.organizationId); }
  return next;
}
