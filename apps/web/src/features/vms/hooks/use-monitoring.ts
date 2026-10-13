import { useQuery } from "@tanstack/react-query";
import { ApiError } from "../../../lib/api/api-error";
import { queryKeys } from "../../../lib/query/query-keys";
import { getAgentStatus, getMonitoringCatalog, getVmMonitoringConfig } from "../api/monitoring.api";
import type { AgentStatusView, MonitoringCatalog, MonitoringConfigView } from "../monitoring.types";
import { isValidVmId } from "./use-vms";

// All GET data is nonsecret. Drafts deliberately do not synchronize to refetches:
// a new remote version must produce an explicit expectedVersion conflict/reload.
export function useMonitoringCatalog(organizationId: string) {
  return useQuery<MonitoringCatalog, ApiError>({
    queryKey: queryKeys.monitoringCatalog(organizationId),
    queryFn: ({ signal }) => getMonitoringCatalog(organizationId, signal),
    enabled: Boolean(organizationId), staleTime: 300_000,
  });
}
export function useVmMonitoringConfig(organizationId: string, vmId: string) {
  return useQuery<MonitoringConfigView, ApiError>({
    queryKey: queryKeys.vmMonitoringConfig(organizationId, vmId),
    queryFn: ({ signal }) => getVmMonitoringConfig(organizationId, vmId, signal),
    enabled: Boolean(organizationId) && isValidVmId(vmId), refetchInterval: 30_000,
  });
}
export function useAgentStatus(organizationId: string, vmId: string) {
  return useQuery<AgentStatusView, ApiError>({
    queryKey: queryKeys.agentStatus(organizationId, vmId),
    queryFn: ({ signal }) => getAgentStatus(organizationId, vmId, signal),
    enabled: Boolean(organizationId) && isValidVmId(vmId), refetchInterval: 15_000,
  });
}
// Saving lives in the keyed form session with a synchronous pending guard and
// AbortController; no useSaveVmMonitoringConfig/useMutation caches credentials.
