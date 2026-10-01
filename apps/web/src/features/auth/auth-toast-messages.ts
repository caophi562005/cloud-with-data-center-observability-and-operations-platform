import {
  GENERIC_API_ERROR_CODE,
  isApiError,
} from "../../lib/api/api-error";

const GENERIC_LOGIN_ERROR = "Sign-in could not be completed. Please try again.";

export function getSafeLoginErrorMessage(error: unknown): string {
  return isApiError(error) && error.code !== GENERIC_API_ERROR_CODE
    ? error.message
    : GENERIC_LOGIN_ERROR;
}

export type AuthToastInput =
  | { kind: "login" }
  | { kind: "login-error"; apiMessage?: string }
  | {
      kind: "registration";
      confirmationRequired: boolean;
      destination?: string;
    }
  | { kind: "confirmation" };

export type AuthToastMessage = {
  title: string;
  message?: string;
};

export function getAuthToastMessage(input: AuthToastInput): AuthToastMessage {
  switch (input.kind) {
    case "login":
      return { title: "Login successful" };
    case "login-error":
      return {
        title: "Login failed",
        message:
          input.apiMessage?.trim() ||
          "Sign-in could not be completed. Please try again.",
      };
    case "confirmation":
      return { title: "Registration confirmed" };
    case "registration":
      return input.confirmationRequired
        ? {
            title: "Registration successful",
            message: input.destination
              ? `A confirmation code was sent to ${input.destination}.`
              : "A confirmation code was sent to your email.",
          }
        : { title: "Registration successful" };
  }
}
