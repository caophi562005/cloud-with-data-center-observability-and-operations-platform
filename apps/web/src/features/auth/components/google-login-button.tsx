import type { JSX } from "react";
import { useState } from "react";
import { PixelButton } from "@pxlkit/ui-kit";
import { useNavigate } from "react-router-dom";
import { authClient } from "../../../lib/auth/auth-client";
import { useAuthSuccessToast } from "../auth-toast";

type GoogleLoginButtonProps = {
  disabled?: boolean;
  onError: (message: string) => void;
  onLoadingChange?: (loading: boolean) => void;
};

const googleMark = (
  <svg
    aria-hidden="true"
    focusable="false"
    height="18"
    viewBox="0 0 24 24"
    width="18"
  >
    <path
      d="M21.35 12.27c0-.7-.06-1.37-.18-2.02H12v3.83h5.24a4.48 4.48 0 0 1-1.94 2.94v2.45h3.14c1.84-1.7 2.91-4.2 2.91-7.2Z"
      fill="#4285F4"
    />
    <path
      d="M12 21.6c2.63 0 4.84-.87 6.45-2.36l-3.14-2.45c-.87.58-1.98.92-3.31.92-2.54 0-4.69-1.72-5.46-4.03H3.3v2.53A9.75 9.75 0 0 0 12 21.6Z"
      fill="#34A853"
    />
    <path
      d="M6.54 13.68A5.86 5.86 0 0 1 6.23 12c0-.58.11-1.15.31-1.68V7.79H3.3A9.6 9.6 0 0 0 2.25 12c0 1.52.36 2.96 1.05 4.21l3.24-2.53Z"
      fill="#FBBC05"
    />
    <path
      d="M12 6.29c1.43 0 2.71.49 3.72 1.46l2.79-2.79C16.84 3.39 14.63 2.4 12 2.4a9.75 9.75 0 0 0-8.7 5.39l3.24 2.53C7.31 8.01 9.46 6.29 12 6.29Z"
      fill="#EA4335"
    />
  </svg>
);

export function GoogleLoginButton({ disabled, onError, onLoadingChange }: GoogleLoginButtonProps): JSX.Element {
  const navigate = useNavigate();
  const showAuthSuccessToast = useAuthSuccessToast();
  const [loading, setLoading] = useState(false);

  const handleClick = async () => {
    onLoadingChange?.(true);
    setLoading(true);
    try {
      await authClient.signInWithGoogle();
      showAuthSuccessToast({ kind: "login" });
      navigate("/dashboard");
    } catch {
      onError("Google sign-in could not be completed. Please try again.");
    } finally {
      setLoading(false);
      onLoadingChange?.(false);
    }
  };

  return (
    <PixelButton
      type="button"
      variant="outline"
      tone="neutral"
      iconLeft={googleMark}
      fullWidth
      disabled={disabled || loading}
      loading={loading}
      onClick={handleClick}
    >
      Continue with Google
    </PixelButton>
  );
}
