import { PxlKitIcon } from "@pxlkit/core";
import { XCircle } from "@pxlkit/feedback";
import { useCallback } from "react";
import { useToast } from "@pxlkit/ui-kit";
import { PxlKitIcon as AppPxlKitIcon } from "../../components/ui/pxlkit-icon";
import {
  getAuthToastMessage,
  type AuthToastInput,
} from "./auth-toast-messages";

export function useAuthSuccessToast() {
  const { toast } = useToast();

  return useCallback(
    (input: AuthToastInput) => {
      const { title, message } = getAuthToastMessage(input);
      toast.success({
        title,
        message,
        icon: <AppPxlKitIcon name="check-circle" />,
      });
    },
    [toast],
  );
}

type AuthErrorToastInput = Extract<AuthToastInput, { kind: "login-error" }>;

export function useAuthErrorToast() {
  const { toast } = useToast();

  return useCallback(
    (input: AuthErrorToastInput) => {
      const { title, message } = getAuthToastMessage(input);
      toast.error({
        title,
        message,
        icon: <PxlKitIcon icon={XCircle} />,
      });
    },
    [toast],
  );
}
