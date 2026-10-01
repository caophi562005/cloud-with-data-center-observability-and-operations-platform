import { describe, expect, it } from "vitest";
import { ApiError } from "../src/lib/api/api-error";

type AuthToastInput =
  | { kind: "login" }
  | { kind: "login-error"; apiMessage?: string }
  | {
      kind: "registration";
      confirmationRequired: boolean;
      destination?: string;
    }
  | { kind: "confirmation" };

type AuthToastMessage = {
  title: string;
  message?: string;
};

type AuthToastMessageHelper = (
  input: AuthToastInput,
) => AuthToastMessage;

async function loadAuthToastMessageHelper(): Promise<AuthToastMessageHelper> {
  let module: Record<string, unknown> = {};

  try {
    module = (await import(
      /* @vite-ignore */ "../src/features/auth/auth-toast-messages"
    )) as unknown as Record<string, unknown>;
  } catch {
    // The helper is intentionally absent during the RED phase.
  }

  const helper = module.getAuthToastMessage;
  expect(
    helper,
    "the auth toast message helper must exist before behavior can pass",
  ).toEqual(expect.any(Function));

  return helper as AuthToastMessageHelper;
}

type SafeLoginErrorMessageHelper = (error: unknown) => string;

async function loadSafeLoginErrorMessageHelper(): Promise<SafeLoginErrorMessageHelper> {
  let module: Record<string, unknown> = {};

  try {
    module = (await import(
      /* @vite-ignore */ "../src/features/auth/auth-toast-messages"
    )) as unknown as Record<string, unknown>;
  } catch {
    // The helper is intentionally absent during the RED phase.
  }

  const helper = module.getSafeLoginErrorMessage;
  expect(
    helper,
    "the safe login error helper must be exported before behavior can pass",
  ).toEqual(expect.any(Function));

  return helper as SafeLoginErrorMessageHelper;
}

describe("auth success toast messages", () => {
  it("returns the login success title", async () => {
    const getAuthToastMessage = await loadAuthToastMessageHelper();

    expect(getAuthToastMessage({ kind: "login" })).toEqual({
      title: "Login successful",
    });
  });

  it("returns registration success without a confirmation message when already confirmed", async () => {
    const getAuthToastMessage = await loadAuthToastMessageHelper();

    expect(
      getAuthToastMessage({
        kind: "registration",
        confirmationRequired: false,
      }),
    ).toEqual({ title: "Registration successful" });
  });

  it("explains where the confirmation code was sent", async () => {
    const getAuthToastMessage = await loadAuthToastMessageHelper();

    expect(
      getAuthToastMessage({
        kind: "registration",
        confirmationRequired: true,
        destination: "a***@example.com",
      }),
    ).toEqual({
      title: "Registration successful",
      message: "A confirmation code was sent to a***@example.com.",
    });
  });

  it("uses an email fallback when the confirmation destination is absent", async () => {
    const getAuthToastMessage = await loadAuthToastMessageHelper();

    expect(
      getAuthToastMessage({
        kind: "registration",
        confirmationRequired: true,
      }),
    ).toEqual({
      title: "Registration successful",
      message: "A confirmation code was sent to your email.",
    });
  });

  it("returns the confirmation success title", async () => {
    const getAuthToastMessage = await loadAuthToastMessageHelper();

    expect(getAuthToastMessage({ kind: "confirmation" })).toEqual({
      title: "Registration confirmed",
    });
  });
});

describe("safe login error messages", () => {
  it("returns the documented API error message", async () => {
    const getSafeLoginErrorMessage = await loadSafeLoginErrorMessageHelper();

    expect(
      getSafeLoginErrorMessage(
        new ApiError({
          statusCode: 401,
          code: "AUTH_INVALID_CREDENTIALS",
          message: "Invalid credentials",
        }),
      ),
    ).toBe("Invalid credentials");
  });

  it("uses the generic login fallback for a generic API error", async () => {
    const getSafeLoginErrorMessage = await loadSafeLoginErrorMessageHelper();

    expect(getSafeLoginErrorMessage(ApiError.generic())).toBe(
      "Sign-in could not be completed. Please try again.",
    );
  });

  it("uses the generic login fallback for an unknown thrown value", async () => {
    const getSafeLoginErrorMessage = await loadSafeLoginErrorMessageHelper();

    expect(getSafeLoginErrorMessage(new Error("unexpected failure"))).toBe(
      "Sign-in could not be completed. Please try again.",
    );
  });
});

describe("auth login error toast messages", () => {
  it("uses the safe API error message", async () => {
    const getAuthToastMessage = await loadAuthToastMessageHelper();

    expect(
      getAuthToastMessage({
        kind: "login-error",
        apiMessage: "Invalid credentials",
      }),
    ).toEqual({
      title: "Login failed",
      message: "Invalid credentials",
    });
  });

  it("uses a generic fallback when no safe API message is available", async () => {
    const getAuthToastMessage = await loadAuthToastMessageHelper();

    expect(getAuthToastMessage({ kind: "login-error" })).toEqual({
      title: "Login failed",
      message: "Sign-in could not be completed. Please try again.",
    });
  });
});
