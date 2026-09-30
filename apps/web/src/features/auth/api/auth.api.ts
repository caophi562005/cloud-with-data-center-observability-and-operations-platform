import { apiFetch } from "../../../lib/api/http-client";
import type {
  ConfirmRegistrationInput,
  LoginInput,
  LoginResponse,
  MeResponse,
  RegisterInput,
  RegistrationResponse,
  SafeUser,
} from "../auth.types";

const JSON_HEADERS = {
  Accept: "application/json",
  "Content-Type": "application/json",
};

export async function login(input: LoginInput): Promise<SafeUser> {
  const response = await apiFetch<LoginResponse>("/api/v1/auth/login", {
    method: "POST",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });

  return response.user;
}

export function register(input: RegisterInput): Promise<RegistrationResponse> {
  return apiFetch<RegistrationResponse>("/api/v1/auth/register", {
    method: "POST",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
}

export function confirmRegistration(
  input: ConfirmRegistrationInput,
): Promise<RegistrationResponse> {
  return apiFetch<RegistrationResponse>("/api/v1/auth/register/confirm", {
    method: "POST",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
}

export function resendConfirmationCode(
  email: string,
): Promise<RegistrationResponse> {
  return apiFetch<RegistrationResponse>("/api/v1/auth/register/resend-code", {
    method: "POST",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify({ email }),
  });
}

export function me(): Promise<MeResponse> {
  return apiFetch<MeResponse>("/api/v1/me", {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
}

export function logout(): Promise<void> {
  return apiFetch<void>("/api/v1/auth/logout", {
    method: "POST",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
}
