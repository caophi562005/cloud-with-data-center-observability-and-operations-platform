import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { ApiError } from "../../../lib/api/api-error";
import { queryKeys } from "../../../lib/query/query-keys";
import {
  createMember,
  getOrganizationMembers,
  removeMember,
  updateMemberRole,
} from "../api/memberships.api";
import type { Member, MembershipCreateInput, Role } from "../../../types/domain";

export function useOrganizationMembers(
  organizationId: string | null,
): UseQueryResult<Member[], ApiError> {
  const queryKey = queryKeys.members(organizationId ?? "");

  return useQuery<Member[], ApiError>({
    queryKey,
    queryFn: () => getOrganizationMembers(organizationId ?? ""),
    enabled: Boolean(organizationId),
  });
}

async function invalidateMembershipQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  organizationId: string,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.me }),
    queryClient.invalidateQueries({ queryKey: queryKeys.organization(organizationId) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.members(organizationId) }),
  ]);
}

export function useCreateMember(
  organizationId: string,
): UseMutationResult<Member, ApiError, MembershipCreateInput> {
  const queryClient = useQueryClient();

  return useMutation<Member, ApiError, MembershipCreateInput>({
    mutationFn: (input) => createMember(organizationId, input),
    onSuccess: async () => {
      await invalidateMembershipQueries(queryClient, organizationId);
    },
  });
}

export interface UpdateMemberRoleVariables {
  userId: string;
  role: Role;
}

export function useUpdateMemberRole(
  organizationId: string,
): UseMutationResult<Member, ApiError, UpdateMemberRoleVariables> {
  const queryClient = useQueryClient();

  return useMutation<Member, ApiError, UpdateMemberRoleVariables>({
    mutationFn: ({ userId, role }) =>
      updateMemberRole(organizationId, userId, role),
    onSuccess: async () => {
      await invalidateMembershipQueries(queryClient, organizationId);
    },
  });
}

export function useRemoveMember(
  organizationId: string,
): UseMutationResult<void, ApiError, string> {
  const queryClient = useQueryClient();

  return useMutation<void, ApiError, string>({
    mutationFn: (userId) => removeMember(organizationId, userId),
    onSuccess: async () => {
      await invalidateMembershipQueries(queryClient, organizationId);
    },
  });
}
