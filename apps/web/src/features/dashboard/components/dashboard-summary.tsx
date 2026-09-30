import { PixelStatCard } from "@pxlkit/ui-kit";
import type { Organization, Role } from "../../../types/domain";

const roleLabels: Record<Role, string> = {
  ADMIN: "Administrator",
  OPERATOR: "Operator",
  VIEWER: "Viewer",
};

function formatRole(role: Role): string {
  return roleLabels[role];
}

export function DashboardSummary({
  organization,
  memberCount,
  role,
}: {
  organization: Organization;
  memberCount: number | null;
  role: Role;
}) {
  return (
    <section className="dashboard-summary" aria-label="Dashboard summary">
      <div className="dashboard-summary-grid">
        <PixelStatCard
          label="Organization"
          value={organization.name}
          tone="cyan"
          surface="pixel"
        />
        <PixelStatCard
          label="Members"
          value={memberCount === null ? "—" : String(memberCount)}
          tone="green"
          surface="pixel"
        />
        <PixelStatCard
          label="Your Role"
          value={formatRole(role)}
          tone="purple"
          surface="pixel"
        />
      </div>
    </section>
  );
}
