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
    <section aria-label="Dashboard summary">
      <div className="grid min-w-0 grid-cols-3 gap-4 max-[1200px]:grid-cols-2 max-[640px]:grid-cols-1 [&>div]:shadow-[4px_4px_0_var(--cloudops-shadow)]">
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
