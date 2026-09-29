export type Role = "ADMIN" | "OPERATOR" | "VIEWER";
export type MemberStatus = "ACTIVE" | "INVITED";

export interface Organization {
  id: string;
  name: string;
  slug: string;
  role: Role;
  plan: string;
  environment: string;
  createdAt: string;
}

export interface Member {
  id: string;
  organizationId: string;
  name: string;
  email: string;
  role: Role;
  status: MemberStatus;
}

export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  role: Role;
}

export interface GettingStartedItem {
  id: string;
  label: string;
  completed: boolean;
  comingSoon?: boolean;
}
