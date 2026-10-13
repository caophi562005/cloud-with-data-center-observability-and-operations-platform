import { useEffect } from "react";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { ApiError } from "../../../lib/api/api-error";
import { queryKeys } from "../../../lib/query/query-keys";
import { getIntegrationCurrentMetrics, getIntegrationMetricsHistory } from "../api/integration-metrics.api";
import type { IntegrationHistoryInput, IntegrationMetricsCurrent, IntegrationMetricsHistory } from "../integration-metrics.types";
import { isValidVmId } from "./use-vms";

export function useIntegrationCurrentMetrics(org: string, vmId: string, instanceId: string, enabled: boolean): UseQueryResult<IntegrationMetricsCurrent, ApiError> {
  const client = useQueryClient();
  useEffect(() => () => { void client.cancelQueries({ queryKey: queryKeys.integrationMetricsCurrent(org, vmId, instanceId), exact: true }); }, [client, org, vmId, instanceId]);
  return useQuery<IntegrationMetricsCurrent, ApiError>({
    queryKey: queryKeys.integrationMetricsCurrent(org, vmId, instanceId),
    queryFn: ({ signal }) => getIntegrationCurrentMetrics(org, vmId, instanceId, signal),
    enabled: enabled && Boolean(org) && isValidVmId(vmId) && isValidVmId(instanceId),
    refetchInterval: 30_000, refetchIntervalInBackground: false, staleTime: 0, gcTime: 0, retry: false,
  });
}
export function useIntegrationMetricsHistory(org: string, vmId: string, instanceId: string, input: IntegrationHistoryInput, enabled: boolean): UseQueryResult<IntegrationMetricsHistory, ApiError> {
  const client = useQueryClient();
  const { range, metric, entity } = input;
  useEffect(() => () => { void client.cancelQueries({ queryKey: queryKeys.integrationMetricsHistory(org, vmId, instanceId, range, metric, entity ?? null), exact: true }); }, [client, org, vmId, instanceId, range, metric, entity]);
  return useQuery<IntegrationMetricsHistory, ApiError>({
    queryKey: queryKeys.integrationMetricsHistory(org, vmId, instanceId, range, metric, entity ?? null),
    queryFn: ({ signal }) => getIntegrationMetricsHistory(org, vmId, instanceId, { range, metric, ...(entity ? { entity } : {}) }, signal),
    enabled: enabled && Boolean(org) && isValidVmId(vmId) && isValidVmId(instanceId) && Boolean(metric),
    // Mounted only for the visible panel/selection. No placeholder/previous data.
    refetchInterval: 60_000, refetchIntervalInBackground: false, staleTime: 30_000, gcTime: 0, retry: false,
  });
}
