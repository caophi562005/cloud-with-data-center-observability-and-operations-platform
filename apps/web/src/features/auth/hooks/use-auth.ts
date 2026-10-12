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
  endClientSession,
  sessionCacheEpoch,
} from "../../../lib/query/session-cache";
import { resumeSessionRequests } from "../../../lib/api/http-client";
import {
  confirmRegistration,
  login,
  logout,
  me,
  register,
  resendConfirmationCode,
} from "../api/auth.api";
import type {
  ConfirmRegistrationInput,
  LoginInput,
  MeResponse,
  RegisterInput,
  RegistrationResponse,
  SafeUser,
} from "../auth.types";

export function useMe(): UseQueryResult<MeResponse, ApiError> {
  return useQuery<MeResponse, ApiError>({
    queryKey: queryKeys.me,
    queryFn: ({ signal }) => me(signal),
    enabled: (query) =>
      !(
        query.state.error instanceof ApiError &&
        query.state.error.statusCode === 401
      ),
    retryOnMount: false,
    refetchOnWindowFocus: (query) =>
      !(
        query.state.error instanceof ApiError &&
        query.state.error.statusCode === 401
      ),
    refetchOnReconnect: (query) =>
      !(
        query.state.error instanceof ApiError &&
        query.state.error.statusCode === 401
      ),
  });
}

export function useLogin(): UseMutationResult<
  SafeUser,
  ApiError,
  LoginInput,
  { epoch: number }
> {
  const queryClient = useQueryClient();

  return useMutation<SafeUser, ApiError, LoginInput, { epoch: number }>({
    networkMode: "always",
    onMutate: () => {
      endClientSession(queryClient);
      return { epoch: sessionCacheEpoch(queryClient) };
    },
    mutationFn: login,
    onSuccess: async (_data, _variables, context) => {
      if (context?.epoch !== sessionCacheEpoch(queryClient)) return;
      resumeSessionRequests();
      await queryClient.resetQueries({ queryKey: queryKeys.me, exact: true });
    },
  });
}

export function useRegister(): UseMutationResult<
  RegistrationResponse,
  ApiError,
  RegisterInput
> {
  return useMutation<RegistrationResponse, ApiError, RegisterInput>({
    mutationFn: register,
  });
}

export function useConfirmRegistration(): UseMutationResult<
  RegistrationResponse,
  ApiError,
  ConfirmRegistrationInput
> {
  return useMutation<RegistrationResponse, ApiError, ConfirmRegistrationInput>({
    mutationFn: confirmRegistration,
  });
}

export function useResendConfirmationCode(): UseMutationResult<
  RegistrationResponse,
  ApiError,
  string
> {
  return useMutation<RegistrationResponse, ApiError, string>({
    mutationFn: resendConfirmationCode,
  });
}

export function useLogout(): UseMutationResult<void, ApiError, void> {
  const queryClient = useQueryClient();

  return useMutation<void, ApiError, void>({
    networkMode: "always",
    onMutate: () => endClientSession(queryClient),
    mutationFn: logout,
  });
}
