import type { JSX } from "react";
import { PixelAvatar, PixelDropdown } from "@pxlkit/ui-kit";
import { currentUser } from "../../mocks/current-user";
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

export function UserMenu(): JSX.Element {
  return (
    <PixelDropdown.Root>
      <PixelDropdown.Trigger
        ariaLabel="Open user menu"
        icon={<AppIcon name="chevron-down" />}
      >
        <span className="flex items-center gap-2">
          <PixelAvatar name={currentUser.name} size="sm" />
          <span className="user-menu-copy">
            <strong>{currentUser.name}</strong>
            <small>{formatRole(currentUser.role)}</small>
          </span>
        </span>
      </PixelDropdown.Trigger>
      <PixelDropdown.Content>
        <PixelDropdown.Header>
          <span className="block">{currentUser.name}</span>
          <span className="block normal-case tracking-normal">{currentUser.email}</span>
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
        <PixelDropdown.Item value="sign-out">Sign out</PixelDropdown.Item>
      </PixelDropdown.Content>
    </PixelDropdown.Root>
  );
}
