import { apiFetch } from "../../../lib/api/http-client";
import type { OrganizationDetails, OrganizationUpdateInput } from "../../../types/domain";

const JSON_HEADERS = {
  Accept: "application/json",
  "Content-Type": "application/json",
};

export interface OrganizationApiResponse {
  id: string;
  name: string;
  slug: string;
}

function organizationPath(organizationId: string): string {
  return `/api/v1/organizations/${encodeURIComponent(organizationId)}`;
}

function toOrganizationDetails(response: OrganizationApiResponse): OrganizationDetails {
  return {
    id: response.id,
    name: response.name,
    slug: response.slug,
  };
}

export async function getOrganization(
  organizationId: string,
): Promise<OrganizationDetails> {
  const response = await apiFetch<OrganizationApiResponse>(
    organizationPath(organizationId),
    {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
    },
  );

  return toOrganizationDetails(response);
}

export async function updateOrganization(
  organizationId: string,
  input: OrganizationUpdateInput,
): Promise<OrganizationDetails> {
  const response = await apiFetch<OrganizationApiResponse>(
    organizationPath(organizationId),
    {
      method: "PATCH",
      credentials: "include",
      headers: JSON_HEADERS,
      body: JSON.stringify(input),
    },
  );

  return toOrganizationDetails(response);
}
