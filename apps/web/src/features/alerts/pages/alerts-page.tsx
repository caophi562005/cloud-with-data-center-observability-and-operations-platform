import { useCallback, type JSX } from "react";
import { PixelButton, PixelEmptyState, PixelPagination } from "@pxlkit/ui-kit";
import { useSearchParams } from "react-router-dom";
import { useTenant } from "../../../app/providers/app-providers";
import { useOrganizationMembers } from "../../memberships/hooks/use-members";
import { useAlerts, useAlertCooldown } from "../hooks/use-alerts";
import { useAlertDrawer } from "../hooks/use-alert-drawer";
import { patchAlertListState, readAlertListState } from "../lib/alert-url-state";
import { toAlertListQuery } from "../lib/alert-utils";
import type { AlertListState } from "../alert.types";
import { AlertSummaryCards } from "../components/alert-summary-cards";
import { AlertFilters } from "../components/alert-filters";
import { AlertListTable } from "../components/alert-list-table";
export function AlertsPage(): JSX.Element {
  const tenant = useTenant(); const drawer = useAlertDrawer(); const [params, setParams] = useSearchParams();
  const state = readAlertListState(params); const org = drawer.listReady ? tenant.currentOrganization?.id ?? null : null;
  const change = useCallback((patch: Partial<AlertListState>) => setParams(patchAlertListState(params, patch), { replace: true, preventScrollReset: true }), [params, setParams]);
  const list = useAlerts(org, toAlertListQuery(state)); const cooldown = useAlertCooldown(list.error); const members = useOrganizationMembers(org, 300_000);
  if (tenant.isLoading || !drawer.listReady && !drawer.unavailable && tenant.currentOrganization) return <p role="status">Loading organization…</p>;
  if (!org) return <PixelEmptyState title="No organization available" description="Select an authorized organization to view alerts." />;
  const errorText = list.error?.statusCode === 403 ? "You do not have permission to view alerts." : list.error?.statusCode === 401 ? "Your session is unavailable. Sign in again." : "Alerts are temporarily unavailable.";
  return <section className="space-y-6" aria-label="Alerts"><div><h1 className="text-2xl font-semibold text-retro-text">Alerts</h1><p className="mt-2 text-sm text-retro-muted">{tenant.currentOrganization?.name} · Signal and acknowledgement are separate.</p></div>
    <AlertSummaryCards organizationId={org} />
    <div className="flex flex-wrap items-center justify-between gap-3"><div role="tablist" aria-label="Alert signal"><PixelButton type="button" role="tab" aria-selected={state.tab === "firing"} variant={state.tab === "firing" ? "solid" : "ghost"} onClick={() => change({ tab: "firing" })}>Firing</PixelButton><PixelButton type="button" role="tab" aria-selected={state.tab === "history"} variant={state.tab === "history" ? "solid" : "ghost"} onClick={() => change({ tab: "history" })}>History</PixelButton></div><PixelButton type="button" variant="ghost" disabled={list.isFetching || cooldown} onClick={() => { if (!cooldown) void list.refetch(); }}>Refresh</PixelButton></div>
    <AlertFilters key={org} state={state} onChange={change} />
    <div role="status" aria-live="polite" className="text-xs text-retro-muted">{list.isFetching ? list.data ? "Refreshing alerts…" : "Loading alerts…" : list.data ? `${list.data.total} matching alerts` : ""}</div>
    {list.isError ? <div role="alert" className="border-2 border-retro-amber p-4"><p>{errorText}</p>{list.data && ![401,403,404].includes(list.error.statusCode) ? <p className="mt-2 text-xs">Previously fetched data from this organization is shown below.</p> : null}<PixelButton type="button" variant="ghost" disabled={cooldown || list.isFetching} onClick={() => { if (!cooldown) void list.refetch(); }}>Retry</PixelButton></div> : null}
    {list.data && !(list.isError && [401,403,404].includes(list.error.statusCode)) ? list.data.items.length ? <AlertListTable items={list.data.items} members={members.data ?? []} selectedId={drawer.selection?.alertId ?? null} onOpen={(row, opener) => drawer.openAlert({ organizationId: org, alertId: row.id }, opener)} /> : <PixelEmptyState title="No matching alerts" description={state.q || state.severity || state.workflowStatus || state.vmId ? "Try changing or clearing the filters." : state.tab === "history" ? "Resolved alerts will appear here when received." : "There are no firing alerts in this organization."} /> : null}
    {list.data && list.data.total > 0 && !(list.isError && [401,403,404].includes(list.error.statusCode)) ? <div className="flex flex-wrap items-center justify-between gap-3"><PixelPagination page={state.page} total={Math.max(1, Math.ceil(list.data.total / state.pageSize))} onChange={(page) => change({ page })} ariaLabel="Alert pages" /><PixelButton type="button" variant="ghost" onClick={() => change({ pageSize: state.pageSize === 100 ? 50 : 100 })}>{state.pageSize} per page</PixelButton></div> : null}
  </section>;
}
