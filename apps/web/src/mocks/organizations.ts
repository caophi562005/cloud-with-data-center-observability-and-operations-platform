import type { Organization } from "../types/domain";

export const organizations: Organization[] = [
  {
    id: "org_001",
    name: "VNPT Cloud",
    slug: "vnpt-cloud",
    role: "ADMIN",
    plan: "Development",
    environment: "Development",
    createdAt: "Sep 2026",
  },
  {
    id: "org_002",
    name: "Cloud Lab",
    slug: "cloud-lab",
    role: "OPERATOR",
    plan: "Development",
    environment: "Staging",
    createdAt: "Aug 2026",
  },
];
