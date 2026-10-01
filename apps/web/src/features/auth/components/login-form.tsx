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
import { useAuthErrorToast, useAuthSuccessToast } from "../auth-toast";
import { getSafeLoginErrorMessage } from "../auth-toast-messages";
import { useLogin } from "../hooks/use-auth";
import { validateCredentials } from "../auth.schema";
import { GoogleLoginButton } from "./google-login-button";

type FieldName = "email" | "password";
type TouchedFields = Record<FieldName, boolean>;
type CredentialErrors = ReturnType<typeof validateCredentials>;

export function LoginForm(): JSX.Element {
  const navigate = useNavigate();
  const loginMutation = useLogin();
  const showAuthSuccessToast = useAuthSuccessToast();
  const showAuthErrorToast = useAuthErrorToast();
  const [isGoogleSubmitting, setIsGoogleSubmitting] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [touched, setTouched] = useState<TouchedFields>({
    email: false,
    password: false,
  });
  const [errors, setErrors] = useState<CredentialErrors>({});
  const [formError, setFormError] = useState<string | undefined>();
  const emailRef = useRef<HTMLInputElement | null>(null);
  const passwordRef = useRef<HTMLInputElement | null>(null);
  const passwordFieldRef = useRef<HTMLDivElement | null>(null);
  const isSubmitting = loginMutation.isPending || isGoogleSubmitting;

  // Interop workaround for the current PxlKit password-toggle implementation.
  useEffect(() => {
    const field = passwordFieldRef.current;
    if (!field) return;

    const makeToggleFocusable = () => {
      field
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Show password"], button[aria-label="Hide password"]',
        )
        ?.removeAttribute("tabindex");
    };

    makeToggleFocusable();
    const observer = new MutationObserver(makeToggleFocusable);
    observer.observe(field, {
      attributes: true,
      attributeFilter: ["tabindex"],
      subtree: true,
    });

    return () => observer.disconnect();
  }, []);

  const handleBlur = (field: FieldName) => {
    const fieldErrors = validateCredentials({ email, password });
    setTouched((currentTouched) => ({ ...currentTouched, [field]: true }));
    setErrors((currentErrors) => ({
      ...currentErrors,
      [field]: fieldErrors[field],
    }));
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const input = { email: email.trim(), password };
    const fieldErrors = validateCredentials(input);
    setTouched({ email: true, password: true });
    setErrors(fieldErrors);

    if (Object.keys(fieldErrors).length > 0) {
      setFormError("Please correct the highlighted fields.");
      const firstInvalidField = fieldErrors.email ? emailRef : passwordRef;
      firstInvalidField.current?.focus();
      return;
    }

    setFormError(undefined);
    try {
      await loginMutation.mutateAsync(input);
      showAuthSuccessToast({ kind: "login" });
      navigate("/dashboard", { replace: true });
    } catch (error) {
      const safeMessage = getSafeLoginErrorMessage(error);
      setFormError(safeMessage);
      showAuthErrorToast({ kind: "login-error", apiMessage: safeMessage });
    }
  };

  return (
    <section
      className="flex min-h-0 min-w-0 justify-center overflow-y-auto bg-[var(--cloudops-page)] px-[clamp(1rem,5vw,5rem)] py-6 sm:py-8 lg:py-10 max-[901px]:overflow-visible max-[640px]:w-full max-[640px]:px-4 max-[640px]:py-8 max-[640px]:pb-12"
      aria-label="Sign in to OpsGrid"
    >
      <PixelCard
        className="my-auto w-full max-w-md"
        title="Welcome back"
        description="Sign in to continue to OpsGrid."
      >
        <form
          className="grid gap-4"
          onSubmit={handleSubmit}
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

          <PixelInput
            ref={emailRef}
            id="login-email"
            label="Email"
            type="email"
            name="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            onBlur={() => handleBlur("email")}
            disabled={isSubmitting}
            aria-describedby={
              touched.email && errors.email ? "login-email-error" : undefined
            }
            error={touched.email ? errors.email : undefined}
          />
          {touched.email && errors.email && (
            <span id="login-email-error" className="sr-only">
              {errors.email}
            </span>
          )}

          <div ref={passwordFieldRef}>
            <PixelPasswordInput
              ref={passwordRef}
              id="login-password"
              label="Password"
              name="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              onBlur={() => handleBlur("password")}
              disabled={isSubmitting}
              error={touched.password ? errors.password : undefined}
              aria-describedby={
                touched.password && errors.password
                  ? "login-password-error"
                  : undefined
              }
              toggleLabels={["Show password", "Hide password"]}
            />
            {touched.password && errors.password && (
              <span id="login-password-error" className="sr-only">
                {errors.password}
              </span>
            )}
          </div>

          <PixelButton
            type="submit"
            fullWidth
            tone="cyan"
            loading={isSubmitting}
          >
            {isSubmitting ? "Signing in..." : "Sign in"}
          </PixelButton>
          <PixelDivider label="OR CONTINUE WITH" />
          <GoogleLoginButton
            disabled={loginMutation.isPending}
            onError={setFormError}
            onLoadingChange={setIsGoogleSubmitting}
          />
          <PixelButton
            type="button"
            fullWidth
            tone="neutral"
            variant="soft"
            disabled={isSubmitting}
            onClick={() => navigate("/register")}
          >
            Create an account
          </PixelButton>
        </form>
      </PixelCard>
    </section>
  );
}
