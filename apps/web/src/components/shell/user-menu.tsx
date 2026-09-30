import type { JSX } from "react";
import { PixelAvatar, PixelDropdown } from "@pxlkit/ui-kit";
import { useNavigate } from "react-router-dom";
import { useLogout, useMe } from "../../features/auth/hooks/use-auth";
import { useTenant } from "../../app/providers/app-providers";
import type { Role } from "../../types/domain";
import { AppIcon } from "../ui/app-icon";

function formatRole(role: Role): string {
  switch (role) {
    case "ADMIN":
      return "Administrator";
    case "OPERATOR":
      return "Operator";
    default:
      return "Viewer";
  }
}

function getDisplayName(displayName: string | null | undefined, email: string | undefined) {
  return displayName?.trim() || email || "Account";
}

export function UserMenu(): JSX.Element {
  const navigate = useNavigate();
  const meQuery = useMe();
  const logoutMutation = useLogout();
  const { currentOrganization } = useTenant();

  const handleLogout = () => {
    logoutMutation.mutate(undefined, {
      onSettled: () => navigate("/login", { replace: true }),
    });
  };
  const user = meQuery.data?.user;
  const displayName = getDisplayName(user?.displayName, user?.email);
  const roleLabel = meQuery.isPending
    ? "Loading..."
    : meQuery.isError
      ? "Account unavailable"
      : currentOrganization
        ? formatRole(currentOrganization.role)
        : "No organization";
  const isDisabled = meQuery.isPending || meQuery.isError || !user;

  return (
    <PixelDropdown.Root>
      <PixelDropdown.Trigger
        ariaLabel="Open user menu"
        icon={<AppIcon name="chevron-down" />}
        disabled={isDisabled}
      >
        <span className="flex items-center gap-2">
          <PixelAvatar name={displayName} size="sm" />
          <span className="user-menu-copy">
            <strong>{meQuery.isPending ? "Loading account..." : displayName}</strong>
            <small>{roleLabel}</small>
          </span>
        </span>
      </PixelDropdown.Trigger>
      <PixelDropdown.Content>
        <PixelDropdown.Header>
          <span className="block">{displayName}</span>
          <span className="block normal-case tracking-normal">
            {user?.email ?? "Account details unavailable"}
          </span>
        </PixelDropdown.Header>
        <PixelDropdown.Item value="profile" icon={<AppIcon name="user" />}>
          Profile
        </PixelDropdown.Item>
        <PixelDropdown.Item
          value="account-settings"
          icon={<AppIcon name="settings" />}
        >
          Account settings
        </PixelDropdown.Item>
        <PixelDropdown.Separator />
        <PixelDropdown.Item
          value="sign-out"
          disabled={logoutMutation.isPending}
          onSelect={handleLogout}
        >
          {logoutMutation.isPending ? "Signing out..." : "Sign out"}
        </PixelDropdown.Item>
      </PixelDropdown.Content>
    </PixelDropdown.Root>
  );
}
