import { apiFetch } from "../../../lib/api/http-client";
import type { Member, MembershipCreateInput, Role } from "../../../types/domain";

const JSON_HEADERS = {
  Accept: "application/json",
  "Content-Type": "application/json",
};

export interface MemberApiResponse {
  id: string;
  userId: string;
  email: string;
  displayName: string | null;
  role: Role;
}

function membersPath(organizationId: string): string {
  return `/api/v1/organizations/${encodeURIComponent(organizationId)}/members`;
}

function memberPath(organizationId: string, userId: string): string {
  return `${membersPath(organizationId)}/${encodeURIComponent(userId)}`;
}

function toMember(
  organizationId: string,
  response: MemberApiResponse,
): Member {
  return {
    id: response.id,
    userId: response.userId,
    organizationId,
    email: response.email,
    displayName: response.displayName,
    role: response.role,
  };
}

export async function getOrganizationMembers(
  organizationId: string,
): Promise<Member[]> {
  const response = await apiFetch<MemberApiResponse[]>(membersPath(organizationId), {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
  });

  return response.map((member) => toMember(organizationId, member));
}

export async function createMember(
  organizationId: string,
  input: MembershipCreateInput,
): Promise<Member> {
  const response = await apiFetch<MemberApiResponse>(membersPath(organizationId), {
    method: "POST",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });

  return toMember(organizationId, response);
}

export async function updateMemberRole(
  organizationId: string,
  userId: string,
  role: Role,
): Promise<Member> {
  const response = await apiFetch<MemberApiResponse>(
    memberPath(organizationId, userId),
    {
      method: "PATCH",
      credentials: "include",
      headers: JSON_HEADERS,
      body: JSON.stringify({ role }),
    },
  );

  return toMember(organizationId, response);
}

export async function removeMember(
  organizationId: string,
  userId: string,
): Promise<void> {
  await apiFetch<void>(memberPath(organizationId, userId), {
    method: "DELETE",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
}
