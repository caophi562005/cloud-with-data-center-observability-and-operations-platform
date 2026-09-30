import { useMemo } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { ApiError } from "../../../lib/api/api-error";
import { queryKeys } from "../../../lib/query/query-keys";
import { useMe } from "../../auth/hooks/use-auth";
import {
  getOrganization,
  updateOrganization,
} from "../api/organizations.api";
import type {
  Organization,
  OrganizationDetails,
  OrganizationUpdateInput,
} from "../../../types/domain";

export function useOrganizations(): Organization[] {
  const meQuery = useMe();

  return useMemo(
    () =>
      meQuery.data?.organizations.map((organization) => ({
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        role: organization.role,
      })) ?? [],
    [meQuery.data?.organizations],
  );
}

export function useOrganization(
  organizationId: string | null,
): UseQueryResult<OrganizationDetails, ApiError> {
  const queryKey = queryKeys.organization(organizationId ?? "");

  return useQuery<OrganizationDetails, ApiError>({
    queryKey,
    queryFn: () => getOrganization(organizationId ?? ""),
    enabled: Boolean(organizationId),
  });
}

export interface UpdateOrganizationVariables {
  organizationId: string;
  input: OrganizationUpdateInput;
}

export function useUpdateOrganization(): UseMutationResult<
  OrganizationDetails,
  ApiError,
  UpdateOrganizationVariables
> {
  const queryClient = useQueryClient();

  return useMutation<
    OrganizationDetails,
    ApiError,
    UpdateOrganizationVariables
  >({
    mutationFn: ({ organizationId, input }) =>
      updateOrganization(organizationId, input),
    onSuccess: async (_organization, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.me }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.organization(variables.organizationId),
        }),
      ]);
    },
  });
}
