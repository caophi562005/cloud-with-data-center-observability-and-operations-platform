import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useTenant } from "../../../app/providers/app-providers";
import { queryKeys } from "../../../lib/query/query-keys";
import { AlertDrawerContext } from "../hooks/use-alert-drawer";
import { patchAlertListState, patchAlertSelection, readAlertSelection } from "../lib/alert-url-state";
import type { AlertSelection } from "../alert.types";
export function AlertDrawerProvider({ children }: { children: ReactNode }) {
  const tenant = useTenant(); const org = tenant.currentOrganization?.id ?? null;
  const [params, setParams] = useSearchParams(); const client = useQueryClient();
  const [scope, setScope] = useState<{ org: string | null; previousOrg: string | null; target: string | null }>({ org, previousOrg: null, target: null });
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (!tenant.isLoading && scope.org !== org) {
    const reset = scope.org ? patchAlertListState(params, { vmId: undefined, q: "", severity: undefined, workflowStatus: undefined, page: 1 }) : params;
    const next = readAlertSelection(params)?.organizationId === org || !scope.org ? reset : patchAlertSelection(reset, null);
    setScope({ org, previousOrg: scope.org, target: next.toString() });
  } else if (scope.target !== null && params.toString() === scope.target) {
    setScope({ org, previousOrg: null, target: null });
  }
  const requested = readAlertSelection(params); const hasSelectionParams = params.has("alertId") || params.has("alertOrganizationId");
  const known = requested && tenant.organizations.some((item) => item.id === requested.organizationId);
  const unavailable = !tenant.isLoading && (tenant.isError || (hasSelectionParams && !known));
  const ready = !tenant.isLoading && !tenant.isError && Boolean(org) && scope.org === org && scope.target === null && (!requested || requested.organizationId === org);
  const selection = ready && known ? requested : null;
  useEffect(() => {
    if (selection) { wasOpen.current = true; return; }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    const target = opener.current;
    if (target?.isConnected && target.tagName !== 'BODY' && !target.closest('[inert], [hidden]') && !target.matches(':disabled')) {
      target.focus(); if (document.activeElement === target) return;
    }
    document.querySelector<HTMLButtonElement>('[data-alert-bell-trigger]:not(:disabled)')?.focus();
  }, [selection]);
  useEffect(() => {
    if (tenant.isLoading || scope.org !== org) return;
    if (scope.target !== null) {
      if (scope.previousOrg) void client.cancelQueries({ queryKey: queryKeys.alerts(scope.previousOrg) });
      setParams(new URLSearchParams(scope.target), { replace: true, preventScrollReset: true }); return;
    }
    if (!tenant.isError && known && requested && org !== requested.organizationId) {
      tenant.selectOrganization(requested.organizationId);
    }
  }, [scope, org, tenant, known, requested, client, setParams]);
  const value = useMemo(() => ({ selection, listReady: ready && !unavailable, unavailable,
    openAlert(next: AlertSelection, target?: HTMLElement) {
      if (!ready || next.organizationId !== org || !tenant.organizations.some((item) => item.id === next.organizationId)) return;
      opener.current = target ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
      setParams(patchAlertSelection(params, next), { preventScrollReset: true });
    },
    closeAlert() { setParams(patchAlertSelection(params, null), { preventScrollReset: true }); }
  }), [selection, ready, unavailable, org, tenant.organizations, params, setParams]);
  return <AlertDrawerContext.Provider value={value}>{children}{unavailable ? <p role="status" className="p-4 text-retro-muted">Alert unavailable for this session.</p> : null}</AlertDrawerContext.Provider>;
}
