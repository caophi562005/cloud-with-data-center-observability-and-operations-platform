export type Role = "ADMIN" | "OPERATOR" | "VIEWER";

export interface Organization {
  id: string;
  name: string;
  slug: string;
  role: Role;
}

export interface OrganizationDetails {
  id: string;
  name: string;
  slug: string;
}

export interface OrganizationUpdateInput {
  name?: string;
  slug?: string;
}

export interface Member {
  id: string;
  userId: string;
  organizationId: string;
  displayName: string | null;
  email: string;
  role: Role;
}

export interface MembershipCreateInput {
  userId: string;
  role: Role;
}

export interface GettingStartedItem {
  id: string;
  label: string;
  completed: boolean;
  comingSoon?: boolean;
}
