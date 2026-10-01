import type { JSX } from "react";
import { PixelDropdown } from "@pxlkit/ui-kit";
import { useTenant } from "../../app/providers/app-providers";
import type { Organization } from "../../types/domain";
import { PxlKitIcon } from "../ui/pxlkit-icon";

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
        icon={<PxlKitIcon name="chevron-down" />}
        disabled={isLoading || isError || !hasOrganizations}
      >
        <span className="flex min-w-0 flex-col items-start gap-[0.1rem] text-left">
          <strong className="max-w-full overflow-hidden text-ellipsis whitespace-nowrap">
            {triggerTitle}
          </strong>
          <small className="text-[0.6875rem] leading-[1.25] text-retro-muted">{triggerRole}</small>
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
                  <PxlKitIcon name="check" />
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
              icon={<PxlKitIcon name="settings" />}
            >
              Organization settings
            </PixelDropdown.Item>
          </>
        ) : null}
      </PixelDropdown.Content>
    </PixelDropdown.Root>
  );
}
