import type { FormEvent, JSX } from "react";
import { useRef, useState } from "react";
import {
  PixelButton,
  PixelCard,
  PixelCheckbox,
  PixelDivider,
  PixelInput,
  PixelPasswordInput,
  PixelTextLink,
} from "@pxlkit/ui-kit";
import { useNavigate } from "react-router-dom";
import { validateCredentials } from "../auth.schema";
import { authClient } from "../../../lib/auth/auth-client";
import { GoogleLoginButton } from "./google-login-button";

type FieldName = "email" | "password";
type TouchedFields = Record<FieldName, boolean>;
type CredentialErrors = ReturnType<typeof validateCredentials>;

export function LoginForm(): JSX.Element {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(false);
  const [touched, setTouched] = useState<TouchedFields>({ email: false, password: false });
  const [errors, setErrors] = useState<CredentialErrors>({});
  const [formError, setFormError] = useState<string | undefined>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const emailRef = useRef<HTMLInputElement | null>(null);
  const passwordRef = useRef<HTMLInputElement | null>(null);

  const handleBlur = (field: FieldName) => {
    const fieldErrors = validateCredentials({ email, password });
    setTouched((currentTouched) => ({ ...currentTouched, [field]: true }));
    setErrors((currentErrors) => ({ ...currentErrors, [field]: fieldErrors[field] }));
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const errors = validateCredentials({ email, password });
    setTouched({ email: true, password: true });
    setErrors(errors);

    if (Object.keys(errors).length > 0) {
      setFormError("Please correct the highlighted fields.");
      const firstInvalidField = errors.email ? emailRef : passwordRef;
      firstInvalidField.current?.focus();
      return;
    }

    setFormError(undefined);
    setIsSubmitting(true);
    try {
      await authClient.signIn({ email, password, rememberMe });
      navigate("/dashboard");
    } catch {
      setFormError("Sign-in could not be completed. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <section className="auth-form-panel" aria-label="Sign in to OpsGrid">
      <PixelCard
        className="w-full max-w-md"
        title="Welcome back"
        description="Sign in to continue to OpsGrid."
      >
        <form className="grid gap-4" onSubmit={handleSubmit} noValidate>
          {formError && (
            <p role="alert" className="text-xs text-retro-red">
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
            error={touched.email ? errors.email : undefined}
          />

          <PixelPasswordInput
            ref={passwordRef}
            id="login-password"
            label="Password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            onBlur={() => handleBlur("password")}
            error={touched.password ? errors.password : undefined}
            aria-describedby={touched.password && errors.password ? "login-password-error" : undefined}
            toggleLabels={["Show password", "Hide password"]}
          />
          {touched.password && errors.password && (
            <span id="login-password-error" className="sr-only">
              {errors.password}
            </span>
          )}

          <div className="flex items-center justify-between gap-4">
            <PixelCheckbox
              id="login-remember"
              label="Remember me"
              checked={rememberMe}
              onChange={setRememberMe}
              tone="cyan"
              disabled={isSubmitting}
            />
            <PixelTextLink
              type="button"
              onClick={() => console.info("Forgot password flow is not implemented in Phase 1.")}
            >
              Forgot password?
            </PixelTextLink>
          </div>

          <PixelButton type="submit" fullWidth tone="cyan" loading={isSubmitting}>
            {isSubmitting ? "Signing in..." : "Sign in"}
          </PixelButton>

          <PixelDivider label="OR CONTINUE WITH" />

          <GoogleLoginButton disabled={isSubmitting} onError={setFormError} />
        </form>
      </PixelCard>
    </section>
  );
}
