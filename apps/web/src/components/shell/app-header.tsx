import type { JSX } from "react";
import {
  PixelBreadcrumb,
  PixelButton,
  PixelIconButton,
} from "@pxlkit/ui-kit";
import { useLocation } from "react-router-dom";
import { AppIcon } from "../ui/app-icon";
import { ThemeToggle } from "./theme-toggle";
import { UserMenu } from "./user-menu";

export function AppHeader(): JSX.Element {
  const { pathname } = useLocation();

  return (
    <header className="flex items-center justify-between gap-4 border-b border-retro-border/40 px-6 py-4">
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
        className="flex items-center gap-2"
        role="group"
        aria-label="Header actions"
      >
        <PixelButton
          type="button"
          tone="neutral"
          variant="soft"
          iconLeft={<AppIcon name="search" />}
        >
          <span className="flex items-center gap-3">
            <span>Search</span>
            <kbd aria-label="Command K">⌘ K</kbd>
          </span>
        </PixelButton>
        <PixelIconButton
          type="button"
          label="Notifications"
          icon={<AppIcon name="bell" />}
        />
        <ThemeToggle />
        <UserMenu />
      </div>
    </header>
  );
}
