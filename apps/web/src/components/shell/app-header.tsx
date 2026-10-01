import type { JSX } from "react";
import {
  PixelBreadcrumb,
  PixelButton,
  PixelIconButton,
} from "@pxlkit/ui-kit";
import { useLocation } from "react-router-dom";
import { PxlKitIcon } from "../ui/pxlkit-icon";
import { ThemeToggle } from "./theme-toggle";
import { UserMenu } from "./user-menu";

export function AppHeader(): JSX.Element {
  const { pathname } = useLocation();

  return (
    <header className="flex flex-[0_0_auto] items-center justify-between gap-4 border-b-2 border-retro-border bg-retro-surface px-6 py-4 shadow-[0_3px_0_var(--cloudops-shadow)] max-[901px]:items-start max-[901px]:flex-wrap max-[901px]:px-4">
      <PixelBreadcrumb
        ariaLabel="Breadcrumb"
        items={[
          {
            label: "Dashboard",
            href: "/dashboard",
            active: pathname === "/dashboard",
          },
        ]}
      />
      <div
        className="flex items-center gap-2 max-[901px]:flex-wrap max-[901px]:min-w-0 max-[901px]:justify-end max-[640px]:w-full max-[640px]:justify-start"
        role="group"
        aria-label="Header actions"
      >
        <PixelButton
          type="button"
          tone="neutral"
          variant="soft"
          iconLeft={<PxlKitIcon name="search" />}
        >
          <span className="flex items-center gap-3">
            <span>Search</span>
            <kbd aria-label="Command K">⌘ K</kbd>
          </span>
        </PixelButton>
        <PixelIconButton
          type="button"
          label="Notifications"
          icon={<PxlKitIcon name="bell" />}
        />
        <ThemeToggle />
        <UserMenu />
      </div>
    </header>
  );
}
