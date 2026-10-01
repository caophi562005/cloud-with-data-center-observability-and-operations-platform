import type { FormEvent, JSX } from "react";
import { useEffect, useRef, useState } from "react";
import {
  PixelButton,
  PixelCard,
  PixelDivider,
  PixelInput,
  PixelPasswordInput,
} from "@pxlkit/ui-kit";
import { useNavigate } from "react-router-dom";
import { isApiError } from "../../../lib/api/api-error";
import { useAuthSuccessToast } from "../auth-toast";
import {
  useConfirmRegistration,
  useRegister,
  useResendConfirmationCode,
} from "../hooks/use-auth";
import { validateConfirmationCode, validateRegistration } from "../auth.schema";
import type { RegisterInput } from "../auth.types";
import { GoogleLoginButton } from "./google-login-button";

type RegistrationField =
  "email" | "displayName" | "password" | "confirmPassword";
type RegistrationErrors = ReturnType<typeof validateRegistration>;
type RegistrationMode = "register" | "confirm";

const GENERIC_REGISTER_ERROR =
  "Registration could not be completed. Please try again.";
const GENERIC_CONFIRMATION_ERROR =
  "Confirmation could not be completed. Please try again.";

function safeErrorMessage(error: unknown, fallback: string): string {
  return isApiError(error) ? error.message : fallback;
}

export function RegisterForm(): JSX.Element {
  const navigate = useNavigate();
  const registerMutation = useRegister();
  const showAuthSuccessToast = useAuthSuccessToast();
  const confirmMutation = useConfirmRegistration();
  const resendMutation = useResendConfirmationCode();
  const [mode, setMode] = useState<RegistrationMode>("register");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [confirmationCode, setConfirmationCode] = useState("");
  const [touched, setTouched] = useState<
    Partial<Record<RegistrationField, boolean>>
  >({});
  const [errors, setErrors] = useState<RegistrationErrors>({});
  const [formError, setFormError] = useState<string | undefined>();
  const [statusMessage, setStatusMessage] = useState<string | undefined>();
  const [isGoogleSubmitting, setIsGoogleSubmitting] = useState(false);
  const emailRef = useRef<HTMLInputElement | null>(null);
  const displayNameRef = useRef<HTMLInputElement | null>(null);
  const passwordRef = useRef<HTMLInputElement | null>(null);
  const confirmPasswordRef = useRef<HTMLInputElement | null>(null);
  const passwordFieldRef = useRef<HTMLDivElement | null>(null);
  const confirmPasswordFieldRef = useRef<HTMLDivElement | null>(null);
  const confirmationCodeRef = useRef<HTMLInputElement | null>(null);
  const isSubmitting =
    registerMutation.isPending ||
    confirmMutation.isPending ||
    resendMutation.isPending ||
    isGoogleSubmitting;

  useEffect(() => {
    const fields = [passwordFieldRef.current, confirmPasswordFieldRef.current];
    const makeTogglesFocusable = () => {
      fields.forEach((field) => {
        field
          ?.querySelector<HTMLButtonElement>(
            'button[aria-label="Show password"], button[aria-label="Hide password"]',
          )
          ?.removeAttribute("tabindex");
      });
    };

    makeTogglesFocusable();
    const observers = fields.flatMap((field) => {
      if (!field) return [];
      const observer = new MutationObserver(makeTogglesFocusable);
      observer.observe(field, {
        attributes: true,
        attributeFilter: ["tabindex"],
        subtree: true,
      });
      return [observer];
    });

    return () => observers.forEach((observer) => observer.disconnect());
  }, [mode]);

  const registrationInput: RegisterInput = {
    email,
    displayName,
    password,
    confirmPassword,
  };

  const handleBlur = (field: RegistrationField) => {
    const fieldErrors = validateRegistration(registrationInput);
    setTouched((currentTouched) => ({ ...currentTouched, [field]: true }));
    setErrors((currentErrors) => ({
      ...currentErrors,
      [field]: fieldErrors[field],
    }));
  };

  const focusFirstInvalidField = (fieldErrors: RegistrationErrors) => {
    const firstInvalidField = fieldErrors.email
      ? emailRef
      : fieldErrors.displayName
        ? displayNameRef
        : fieldErrors.password
          ? passwordRef
          : confirmPasswordRef;
    firstInvalidField.current?.focus();
  };

  const handleRegister = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const input = {
      ...registrationInput,
      email: email.trim(),
      displayName: displayName.trim(),
    };
    const fieldErrors = validateRegistration(input);
    setTouched({
      email: true,
      displayName: true,
      password: true,
      confirmPassword: true,
    });
    setErrors(fieldErrors);

    if (Object.keys(fieldErrors).length > 0) {
      setFormError("Please correct the highlighted fields.");
      focusFirstInvalidField(fieldErrors);
      return;
    }

    setFormError(undefined);
    setStatusMessage(undefined);
    try {
      const response = await registerMutation.mutateAsync(input);
      showAuthSuccessToast({
        kind: "registration",
        confirmationRequired: response.status === "CONFIRMATION_REQUIRED",
        destination: response.destination,
      });
      if (response.status === "CONFIRMED") {
        navigate("/login", { replace: true });
        return;
      }

      setEmail(input.email);
      setDisplayName(input.displayName);
      setPassword("");
      setConfirmPassword("");
      setConfirmationCode("");
      setMode("confirm");
      setStatusMessage(
        response.destination
          ? `A confirmation code was sent to ${response.destination}.`
          : "A confirmation code was sent to your email.",
      );
      window.setTimeout(() => confirmationCodeRef.current?.focus(), 0);
    } catch (error) {
      if (isApiError(error) && error.code === "AUTH_REGISTRATION_PENDING") {
        setMode("confirm");
        setStatusMessage(
          "This registration may already be pending. Request a new code below.",
        );
        window.setTimeout(() => confirmationCodeRef.current?.focus(), 0);
      }
      setFormError(safeErrorMessage(error, GENERIC_REGISTER_ERROR));
    }
  };

  const handleConfirm = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const codeError = validateConfirmationCode(confirmationCode);
    if (codeError) {
      setFormError(codeError);
      confirmationCodeRef.current?.focus();
      return;
    }

    setFormError(undefined);
    setStatusMessage(undefined);
    try {
      await confirmMutation.mutateAsync({
        email,
        confirmationCode: confirmationCode.trim(),
      });
      showAuthSuccessToast({ kind: "confirmation" });
      navigate("/login", { replace: true });
    } catch (error) {
      setFormError(safeErrorMessage(error, GENERIC_CONFIRMATION_ERROR));
    }
  };

  const handleResend = async () => {
    setFormError(undefined);
    setStatusMessage(undefined);
    try {
      const response = await resendMutation.mutateAsync(email);
      setStatusMessage(
        response.destination
          ? `A new confirmation code was sent to ${response.destination}.`
          : "A new confirmation code was sent to your email.",
      );
    } catch (error) {
      setFormError(safeErrorMessage(error, GENERIC_CONFIRMATION_ERROR));
    }
  };

  if (mode === "confirm") {
    return (
      <section
        className="flex min-h-0 min-w-0 justify-center overflow-y-auto bg-[var(--cloudops-page)] px-[clamp(1rem,5vw,5rem)] py-6 sm:py-8 lg:py-10 max-[901px]:overflow-visible max-[640px]:w-full max-[640px]:px-4 max-[640px]:py-8 max-[640px]:pb-12"
        aria-label="Confirm your OpsGrid account"
      >
        <PixelCard
          className="my-auto w-full max-w-md"
          title="Confirm your account"
          description="Enter the code Cognito sent to your email."
        >
          <form
            className="grid gap-4"
            onSubmit={handleConfirm}
            noValidate
            aria-busy={isSubmitting}
          >
            {formError && (
              <p
                role="alert"
                aria-live="polite"
                className="text-xs text-retro-red"
              >
                {formError}
              </p>
            )}
            {statusMessage && (
              <p
                role="status"
                aria-live="polite"
                className="text-xs text-retro-cyan"
              >
                {statusMessage}
              </p>
            )}
            <PixelInput
              id="register-confirm-email"
              label="Email"
              type="email"
              value={email}
              disabled
              autoComplete="email"
            />
            <PixelInput
              ref={confirmationCodeRef}
              id="register-confirmation-code"
              label="Confirmation code"
              type="text"
              name="confirmationCode"
              autoComplete="one-time-code"
              inputMode="numeric"
              maxLength={32}
              value={confirmationCode}
              onChange={(event) => setConfirmationCode(event.target.value)}
              disabled={isSubmitting}
            />
            <PixelButton
              type="submit"
              fullWidth
              tone="cyan"
              loading={confirmMutation.isPending}
            >
              {confirmMutation.isPending ? "Confirming..." : "Confirm account"}
            </PixelButton>
            <PixelButton
              type="button"
              fullWidth
              tone="neutral"
              variant="soft"
              loading={resendMutation.isPending}
              disabled={isSubmitting}
              onClick={() => void handleResend()}
            >
              {resendMutation.isPending ? "Sending..." : "Send a new code"}
            </PixelButton>
            <PixelButton
              type="button"
              fullWidth
              tone="neutral"
              variant="soft"
              disabled={isSubmitting}
              onClick={() => {
                setMode("register");
                setConfirmationCode("");
                setFormError(undefined);
                setStatusMessage(undefined);
              }}
            >
              Back to registration
            </PixelButton>
          </form>
        </PixelCard>
      </section>
    );
  }

  return (
    <section
      className="flex min-h-0 min-w-0 justify-center overflow-y-auto bg-[var(--cloudops-page)] px-[clamp(1rem,5vw,5rem)] py-6 sm:py-8 lg:py-10 max-[901px]:overflow-visible max-[640px]:w-full max-[640px]:px-4 max-[640px]:py-8 max-[640px]:pb-12"
      aria-label="Create an OpsGrid account"
    >
      <PixelCard
        className="my-auto w-full max-w-md"
        title="Create your account"
        description="Register with your Cognito email and password."
      >
        <form
          className="grid gap-4"
          onSubmit={handleRegister}
          noValidate
          aria-busy={isSubmitting}
        >
          {formError && (
            <p
              role="alert"
              aria-live="polite"
              className="text-xs text-retro-red"
            >
              {formError}
            </p>
          )}
          {statusMessage && (
            <p
              role="status"
              aria-live="polite"
              className="text-xs text-retro-cyan"
            >
              {statusMessage}
            </p>
          )}
          <PixelInput
            ref={emailRef}
            id="register-email"
            label="Email"
            type="email"
            name="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            onBlur={() => handleBlur("email")}
            disabled={isSubmitting}
            aria-describedby={
              touched.email && errors.email ? "register-email-error" : undefined
            }
            error={touched.email ? errors.email : undefined}
          />
          {touched.email && errors.email && (
            <span id="register-email-error" className="sr-only">
              {errors.email}
            </span>
          )}
          <PixelInput
            ref={displayNameRef}
            id="register-display-name"
            label="Display name"
            type="text"
            name="displayName"
            autoComplete="name"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            onBlur={() => handleBlur("displayName")}
            disabled={isSubmitting}
            aria-describedby={
              touched.displayName && errors.displayName
                ? "register-display-name-error"
                : undefined
            }
            error={touched.displayName ? errors.displayName : undefined}
          />
          {touched.displayName && errors.displayName && (
            <span id="register-display-name-error" className="sr-only">
              {errors.displayName}
            </span>
          )}
          <div ref={passwordFieldRef}>
            <PixelPasswordInput
              ref={passwordRef}
              id="register-password"
              label="Password"
              name="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              onBlur={() => handleBlur("password")}
              disabled={isSubmitting}
              error={touched.password ? errors.password : undefined}
              aria-describedby={
                touched.password && errors.password
                  ? "register-password-error"
                  : undefined
              }
              toggleLabels={["Show password", "Hide password"]}
            />
            {touched.password && errors.password && (
              <span id="register-password-error" className="sr-only">
                {errors.password}
              </span>
            )}
          </div>
          <div ref={confirmPasswordFieldRef}>
            <PixelPasswordInput
              ref={confirmPasswordRef}
              id="register-confirm-password"
              label="Confirm password"
              name="confirmPassword"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              onBlur={() => handleBlur("confirmPassword")}
              disabled={isSubmitting}
              error={
                touched.confirmPassword ? errors.confirmPassword : undefined
              }
              aria-describedby={
                touched.confirmPassword && errors.confirmPassword
                  ? "register-confirm-password-error"
                  : undefined
              }
              toggleLabels={["Show password", "Hide password"]}
            />
            {touched.confirmPassword && errors.confirmPassword && (
              <span id="register-confirm-password-error" className="sr-only">
                {errors.confirmPassword}
              </span>
            )}
          </div>
          <PixelButton
            type="submit"
            fullWidth
            tone="cyan"
            loading={registerMutation.isPending}
          >
            {registerMutation.isPending
              ? "Creating account..."
              : "Create account"}
          </PixelButton>
          <PixelDivider label="OR CONTINUE WITH" />
          <GoogleLoginButton
            disabled={registerMutation.isPending}
            onError={setFormError}
            onLoadingChange={setIsGoogleSubmitting}
          />
          <PixelButton
            type="button"
            fullWidth
            tone="neutral"
            variant="soft"
            disabled={isSubmitting}
            onClick={() => navigate("/login")}
          >
            Back to sign in
          </PixelButton>
        </form>
      </PixelCard>
    </section>
  );
}
