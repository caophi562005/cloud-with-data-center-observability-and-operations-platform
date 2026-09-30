import type { JSX } from "react";
import { PixelDropdown } from "@pxlkit/ui-kit";
import type { Organization } from "../../types/domain";
import { useTenant } from "../../app/providers/app-providers";
import { AppIcon } from "../ui/app-icon";

function formatRole(role: Organization["role"]): string {
  switch (role) {
    case "ADMIN":
      return "Admin";
    case "OPERATOR":
      return "Operator";
    default:
      return "Viewer";
  }
}

export function TenantSwitcher(): JSX.Element {
  const { organizations, currentOrganization, selectOrganization } = useTenant();

  return (
    <PixelDropdown.Root>
      <PixelDropdown.Trigger
        ariaLabel="Switch organization"
        icon={<AppIcon name="chevron-down" />}
      >
        <span className="tenant-switcher-copy">
          <strong>{currentOrganization.name}</strong>
          <small>{formatRole(currentOrganization.role)}</small>
        </span>
      </PixelDropdown.Trigger>
      <PixelDropdown.Content>
        <PixelDropdown.Header>Switch organization</PixelDropdown.Header>
        {organizations.map((organization) => (
          <PixelDropdown.Item
            key={organization.id}
            value={organization.id}
            icon={
              organization.id === currentOrganization.id ? (
                <AppIcon name="check" />
              ) : undefined
            }
            onSelect={() => selectOrganization(organization.id)}
          >
            {organization.name}
          </PixelDropdown.Item>
        ))}
        <PixelDropdown.Separator />
        <PixelDropdown.Item
          value="organization-settings"
          icon={<AppIcon name="settings" />}
        >
          Organization settings
        </PixelDropdown.Item>
      </PixelDropdown.Content>
    </PixelDropdown.Root>
  );
}
