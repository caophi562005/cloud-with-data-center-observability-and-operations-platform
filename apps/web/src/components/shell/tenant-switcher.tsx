import type { JSX } from "react";
import { PixelDropdown } from "@pxlkit/ui-kit";
import { useTenant } from "../../app/providers/app-providers";
import type { Organization } from "../../types/domain";
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
  const {
    organizations,
    currentOrganization,
    selectOrganization,
    isLoading,
    isError,
  } = useTenant();
  const hasOrganizations = organizations.length > 0;
  const triggerTitle = isLoading
    ? "Loading organizations..."
    : isError
      ? "Organizations unavailable"
      : currentOrganization?.name ?? "No organization";
  const triggerRole = isLoading
    ? "Loading..."
    : isError
      ? "Try again later"
      : currentOrganization
        ? formatRole(currentOrganization.role)
        : "No access";

  return (
    <PixelDropdown.Root>
      <PixelDropdown.Trigger
        ariaLabel="Switch organization"
        icon={<AppIcon name="chevron-down" />}
        disabled={isLoading || isError || !hasOrganizations}
      >
        <span className="tenant-switcher-copy">
          <strong>{triggerTitle}</strong>
          <small>{triggerRole}</small>
        </span>
      </PixelDropdown.Trigger>
      <PixelDropdown.Content>
        <PixelDropdown.Header>Switch organization</PixelDropdown.Header>
        {isLoading ? (
          <PixelDropdown.Item value="organizations-loading" disabled>
            Loading organizations...
          </PixelDropdown.Item>
        ) : isError ? (
          <PixelDropdown.Item value="organizations-error" disabled>
            Organizations are unavailable.
          </PixelDropdown.Item>
        ) : !hasOrganizations ? (
          <PixelDropdown.Item value="organizations-empty" disabled>
            No organizations available.
          </PixelDropdown.Item>
        ) : (
          organizations.map((organization) => (
            <PixelDropdown.Item
              key={organization.id}
              value={organization.id}
              icon={
                organization.id === currentOrganization?.id ? (
                  <AppIcon name="check" />
                ) : undefined
              }
              onSelect={() => selectOrganization(organization.id)}
            >
              {organization.name}
            </PixelDropdown.Item>
          ))
        )}
        {currentOrganization ? (
          <>
            <PixelDropdown.Separator />
            <PixelDropdown.Item
              value="organization-settings"
              icon={<AppIcon name="settings" />}
            >
              Organization settings
            </PixelDropdown.Item>
          </>
        ) : null}
      </PixelDropdown.Content>
    </PixelDropdown.Root>
  );
}
