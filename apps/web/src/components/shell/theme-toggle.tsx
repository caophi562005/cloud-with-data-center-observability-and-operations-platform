import type { JSX } from "react";
import { PixelIconButton } from "@pxlkit/ui-kit";
import { useTheme } from "../../app/providers/app-providers";
import { PxlKitIcon } from "../ui/pxlkit-icon";

export function ThemeToggle(): JSX.Element {
  const { resolved, toggle } = useTheme();
  const isDark = resolved === "dark";

  return (
    <PixelIconButton
      type="button"
      label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      icon={<PxlKitIcon name={isDark ? "sun" : "moon"} />}
      onClick={toggle}
    />
  );
}
