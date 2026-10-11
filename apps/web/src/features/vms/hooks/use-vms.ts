import {
  useMutation,
  useQuery,
  useQueryClient,
  queryOptions,
  type QueryClient,
  type UseMutationOptions,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { ApiError } from "../../../lib/api/api-error";
import { queryKeys } from "../../../lib/query/query-keys";
import {
  addVmTag,
  createVm,
  getVm,
  getVms,
  getVmCurrentMetrics,
  getVmMetricsRange,
  updateVmTag,
  deleteVmTag,
  issueVmEnrollmentToken,
  type VmCreateResponse,
  type VmEnrollmentToken,
} from "../api/vms.api";
import type { Vm, VmCurrentMetrics, VmMetricsRange, VmTimeRange } from "../vm.types";

export interface CreateVmVariables {
  hostname: string;
  tags: Record<string, string>;
}

export interface CreateVmResult extends VmCreateResponse {
  failedTags: string[];
}

export function isValidVmId(vmId: string | null | undefined): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(vmId ?? "");
}

export function vmsQueryOptions(organizationId: string | null) {
  return queryOptions<Vm[], ApiError>({
    queryKey: queryKeys.vms(organizationId ?? ""),
    queryFn: ({ signal }) => getVms(organizationId ?? "", signal),
    enabled: Boolean(organizationId),
    refetchInterval: 30_000,
  });
}
export function useVms(organizationId: string | null): UseQueryResult<Vm[], ApiError> {
  return useQuery(vmsQueryOptions(organizationId));
}
export function useVm(organizationId: string | null, vmId: string | null): UseQueryResult<Vm, ApiError> {
  return useQuery<Vm, ApiError>({
    queryKey: queryKeys.vm(organizationId ?? "", vmId ?? ""),
    queryFn: ({ signal }) => getVm(organizationId ?? "", vmId ?? "", signal),
    enabled: Boolean(organizationId) && isValidVmId(vmId),
    refetchInterval: 30_000,
  });
}
export function vmCurrentMetricsQueryOptions(organizationId: string | null, vmId: string | null) {
  return queryOptions<VmCurrentMetrics, ApiError>({
    queryKey: queryKeys.vmCurrentMetrics(organizationId ?? "", vmId ?? ""),
    queryFn: ({ signal }) => getVmCurrentMetrics(organizationId ?? "", vmId ?? "", signal),
    enabled: Boolean(organizationId) && isValidVmId(vmId),
    refetchInterval: 30_000,
  });
}
export function useVmCurrentMetrics(organizationId: string | null, vmId: string | null): UseQueryResult<VmCurrentMetrics, ApiError> {
  return useQuery(vmCurrentMetricsQueryOptions(organizationId, vmId));
}
export function vmMetricsRangeQueryOptions(organizationId: string | null, vmId: string | null, range: VmTimeRange) {
  const cadence = { "1h": 60_000, "6h": 60_000, "24h": 300_000, "7d": 1_800_000 }[range];
  return queryOptions<VmMetricsRange, ApiError>({
    queryKey: queryKeys.vmMetricsRange(organizationId ?? "", vmId ?? "", range),
    queryFn: ({ signal }) => getVmMetricsRange(organizationId ?? "", vmId ?? "", range, signal),
    enabled: Boolean(organizationId) && isValidVmId(vmId),
    staleTime: cadence,
    refetchInterval: cadence,
  });
}
export function useVmMetricsRange(organizationId: string | null, vmId: string | null, range: VmTimeRange): UseQueryResult<VmMetricsRange, ApiError> {
  return useQuery(vmMetricsRangeQueryOptions(organizationId, vmId, range));
}

export type VmTagOperation =
  | { action: "add"; input: { key: string; value: string } }
  | { action: "update"; tagId: string; input: { key: string; value: string } }
  | { action: "delete"; tagId: string };
export function vmTagMutationOptions(queryClient: QueryClient, organizationId: string | null, vmId: string | null): UseMutationOptions<void, ApiError, VmTagOperation> {
  return {
    mutationFn: async (operation) => {
      if (!organizationId || !isValidVmId(vmId) || !vmId) throw ApiError.generic(400);
      if (operation.action === "add") await addVmTag(organizationId, vmId, operation.input);
      else if (operation.action === "update") await updateVmTag(organizationId, vmId, operation.tagId, operation.input);
      else await deleteVmTag(organizationId, vmId, operation.tagId);
    },
    onSuccess: async () => {
      if (!organizationId || !vmId) return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.vms(organizationId), exact: true }),
        queryClient.invalidateQueries({ queryKey: queryKeys.vm(organizationId, vmId), exact: true }),
      ]);
    },
    retry: false,
  };
}
export function useVmTagMutation(organizationId: string | null, vmId: string | null) {
  return useMutation(vmTagMutationOptions(useQueryClient(), organizationId, vmId));
}

export function useIssueVmEnrollmentToken(
  organizationId: string | null,
  vmId: string | null,
): UseMutationResult<VmEnrollmentToken, ApiError, void> {
  const queryClient = useQueryClient();

  return useMutation<VmEnrollmentToken, ApiError, void>({
    mutationFn: () => {
      if (!organizationId || !vmId) {
        throw ApiError.generic(400);
      }
      return issueVmEnrollmentToken(organizationId, vmId);
    },
    onSuccess: async () => {
      if (!organizationId || !vmId) return;
      await queryClient.invalidateQueries({
        queryKey: queryKeys.vm(organizationId, vmId),
      });
    },
  });
}

export function useCreateVm(
  organizationId: string | null,
): UseMutationResult<CreateVmResult, ApiError, CreateVmVariables> {
  const queryClient = useQueryClient();

  return useMutation<CreateVmResult, ApiError, CreateVmVariables>({
    mutationFn: async ({ hostname, tags }) => {
      if (!organizationId) {
        throw ApiError.generic(400);
      }

      const response = await createVm(organizationId, { hostname });
      const tagEntries = Object.entries(tags);
      const tagResults = await Promise.allSettled(
        tagEntries.map(([key, value]) =>
          addVmTag(organizationId, response.vm.id, { key, value }),
        ),
      );
      const failedTags = tagResults.flatMap((result, index) =>
        result.status === "rejected" ? [tagEntries[index][0]] : [],
      );
      const appliedTags = Object.fromEntries(
        tagEntries.flatMap(([key, value], index) =>
          tagResults[index].status === "fulfilled" ? [[key, value]] : [],
        ),
      );

      return {
        ...response,
        vm: {
          ...response.vm,
          tags: appliedTags,
        },
        failedTags,
      };
    },
    onSuccess: async () => {
      if (!organizationId) return;
      await queryClient.invalidateQueries({
        queryKey: queryKeys.vms(organizationId),
      });
    },
  });
}
