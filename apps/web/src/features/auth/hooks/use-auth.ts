import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { ApiError } from "../../../lib/api/api-error";
import { queryKeys } from "../../../lib/query/query-keys";
import { login, logout, me } from "../api/auth.api";
import type { LoginInput, MeResponse, SafeUser } from "../auth.types";

export function useMe(): UseQueryResult<MeResponse, ApiError> {
  return useQuery<MeResponse, ApiError>({
    queryKey: queryKeys.me,
    queryFn: me,
  });
}

export function useLogin(): UseMutationResult<SafeUser, ApiError, LoginInput> {
  const queryClient = useQueryClient();

  return useMutation<SafeUser, ApiError, LoginInput>({
    mutationFn: login,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.me });
    },
  });
}

export function useLogout(): UseMutationResult<void, ApiError, void> {
  const queryClient = useQueryClient();

  return useMutation<void, ApiError, void>({
    mutationFn: logout,
    onSettled: () => {
      queryClient.removeQueries({ queryKey: queryKeys.me });
    },
  });
}
