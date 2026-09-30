import type { JSX } from "react";
import { PixelAvatar, PixelSidebar } from "@pxlkit/ui-kit";
import { useLocation, useNavigate } from "react-router-dom";
import { navigationSections } from "../../app/navigation/navigation.config";
import { useMe } from "../../features/auth/hooks/use-auth";
import { useTenant } from "../../app/providers/app-providers";
import { AppIcon } from "../ui/app-icon";
import { TenantSwitcher } from "./tenant-switcher";

interface AppSidebarProps {
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
}

function getDisplayName(displayName: string | null | undefined, email: string | undefined) {
  return displayName?.trim() || email || "Account";
}

function formatRole(role: "ADMIN" | "OPERATOR" | "VIEWER" | undefined): string {
  switch (role) {
    case "ADMIN":
      return "Administrator";
    case "OPERATOR":
      return "Operator";
    case "VIEWER":
      return "Viewer";
    default:
      return "No organization";
  }
}

export function AppSidebar({ collapsed, onCollapsedChange }: AppSidebarProps): JSX.Element {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const meQuery = useMe();
  const { currentOrganization } = useTenant();
  const displayName = getDisplayName(
    meQuery.data?.user.displayName,
    meQuery.data?.user.email,
  );
  const sections = navigationSections
    .map((section) => ({
      label: section.label,
      items: section.items
        .filter((item) => !item.disabled)
        .map((item) => ({
          id: item.id,
          label: item.label,
          onSelect: () => navigate(item.href),
          icon: <AppIcon name={item.icon} />,
          active: pathname === item.href,
        })),
    }))
    .filter((section) => section.items.length > 0);

  return (
    <PixelSidebar
      collapsible
      collapsed={collapsed}
      onCollapsedChange={onCollapsedChange}
      sections={sections}
      header={
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="inline-flex shrink-0 items-center justify-center text-retro-cyan">
              <AppIcon name="cloud" size={20} />
            </span>
            <strong className="truncate text-sm text-retro-text">OpsGrid</strong>
          </div>
          <TenantSwitcher />
        </div>
      }
      footer={
        <div className="flex items-center gap-2">
          <PixelAvatar name={displayName} size="sm" />
          {!collapsed && (
            <span className="min-w-0">
              <strong className="block truncate text-xs text-retro-text">
                {meQuery.isPending ? "Loading account..." : displayName}
              </strong>
              <small className="block text-[10px] text-retro-muted">
                {formatRole(currentOrganization?.role)}
              </small>
            </span>
          )}
        </div>
      }
      aria-label={`OpsGrid navigation${currentOrganization ? ` for ${currentOrganization.name}` : ""}`}
    />
  );
}
