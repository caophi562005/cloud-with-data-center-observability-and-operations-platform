import type { SignInInput } from "./auth.types";

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
  input: Pick<SignInInput, "email" | "password">,
): Partial<Record<"email" | "password", string>> {
  const errors: Partial<Record<"email" | "password", string>> = {};
  const emailError = validateEmail(input.email);
  const passwordError = validatePassword(input.password);

  if (emailError) errors.email = emailError;
  if (passwordError) errors.password = passwordError;

  return errors;
}
