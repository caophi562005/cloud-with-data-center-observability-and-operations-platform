import type { JSX } from "react";
import { gettingStartedItems } from "../../../mocks/getting-started";
import { membersByOrganization } from "../../../mocks/members";
import { useTenant } from "../../../app/providers/app-providers";
import { DashboardSummary } from "../components/dashboard-summary";
import { DashboardWelcome } from "../components/dashboard-welcome";
import { GettingStarted } from "../components/getting-started";
import { OrganizationOverview } from "../components/organization-overview";
import { RecentMembers } from "../components/recent-members";

export function DashboardPage(): JSX.Element {
  const { currentOrganization } = useTenant();
  const members = membersByOrganization[currentOrganization.id] ?? [];

  return (
    <div className="dashboard-page">
      <DashboardWelcome firstName="Admin" organizationName={currentOrganization.name} />
      <DashboardSummary
        organization={currentOrganization}
        memberCount={members.length}
        role={currentOrganization.role}
      />
      <div className="dashboard-primary-grid">
        <OrganizationOverview organization={currentOrganization} />
        <GettingStarted items={gettingStartedItems} />
      </div>
      <RecentMembers members={members.slice(0, 3)} />
    </div>
  );
}
