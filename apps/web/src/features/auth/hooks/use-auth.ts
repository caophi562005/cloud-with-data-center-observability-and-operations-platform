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
    mutationFn: logout,
    onSettled: () => {
      queryClient.removeQueries({ queryKey: queryKeys.me });
    },
  });
}
