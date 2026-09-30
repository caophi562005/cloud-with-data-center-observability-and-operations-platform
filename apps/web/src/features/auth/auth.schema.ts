import type { LoginInput, RegisterInput } from "./auth.types";

export function validateEmail(email: string): string | undefined {
  if (!email.trim()) return "Email is required.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return "Please enter a valid email address.";
  }
  return undefined;
}

export function validatePassword(password: string): string | undefined {
  return password ? undefined : "Password is required.";
}

export function validateCredentials(
  input: LoginInput,
): Partial<Record<"email" | "password", string>> {
  const errors: Partial<Record<"email" | "password", string>> = {};
  const emailError = validateEmail(input.email);
  const passwordError = validatePassword(input.password);

  if (emailError) errors.email = emailError;
  if (passwordError) errors.password = passwordError;

  return errors;
}

const REGISTRATION_PASSWORD_ERROR =
  "Password must be at least 12 characters and include uppercase, lowercase, and a number.";

export function validateRegistration(
  input: RegisterInput,
): Partial<
  Record<"email" | "displayName" | "password" | "confirmPassword", string>
> {
  const errors: Partial<
    Record<"email" | "displayName" | "password" | "confirmPassword", string>
  > = {};
  const emailError = validateEmail(input.email);

  if (emailError) errors.email = emailError;
  if (!input.displayName.trim()) {
    errors.displayName = "Display name is required.";
  }

  const hasCognitoPasswordPolicy =
    input.password.length >= 12 &&
    /[a-z]/.test(input.password) &&
    /[A-Z]/.test(input.password) &&
    /[0-9]/.test(input.password);
  if (!hasCognitoPasswordPolicy) {
    errors.password = REGISTRATION_PASSWORD_ERROR;
  }
  if (!input.confirmPassword) {
    errors.confirmPassword = "Please confirm your password.";
  } else if (input.password !== input.confirmPassword) {
    errors.confirmPassword = "Passwords do not match.";
  }

  return errors;
}

export function validateConfirmationCode(code: string): string | undefined {
  return code.trim() ? undefined : "Confirmation code is required.";
}
