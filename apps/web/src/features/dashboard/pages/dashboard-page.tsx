import type { JSX } from "react";
import { useMe } from "../../auth/hooks/use-auth";
import { useOrganizationMembers } from "../../memberships/hooks/use-members";
import { gettingStartedItems } from "../../../mocks/getting-started";
import { useTenant } from "../../../app/providers/app-providers";
import { DashboardSummary } from "../components/dashboard-summary";
import { DashboardWelcome } from "../components/dashboard-welcome";
import { GettingStarted } from "../components/getting-started";
import { OrganizationOverview } from "../components/organization-overview";
import { RecentMembers } from "../components/recent-members";

function DashboardState({
  title,
  message,
  role = "status",
}: {
  title: string;
  message: string;
  role?: "status" | "alert";
}): JSX.Element {
  return (
    <section
      className="grid min-w-0 gap-3 border-2 border-retro-border bg-retro-surface p-[clamp(1.5rem,4vw,3rem)] shadow-[4px_4px_0_var(--cloudops-shadow)]"
      role={role}
      aria-live="polite"
    >
      <h1 className="text-retro-cyan font-[var(--font-pixel)] text-[clamp(1rem,2vw,1.25rem)] font-normal leading-normal uppercase [overflow-wrap:anywhere]">
        {title}
      </h1>
      <p className="max-w-3xl text-retro-muted [overflow-wrap:anywhere]">{message}</p>
    </section>
  );
}

function getFirstName(displayName: string | null | undefined, email: string | undefined): string {
  const source = displayName?.trim() || email?.split("@", 1)[0] || "there";
  return source.split(/\s+/u, 1)[0] || "there";
}

export function DashboardPage(): JSX.Element {
  const meQuery = useMe();
  const { currentOrganization, isLoading, isError } = useTenant();
  const membersQuery = useOrganizationMembers(currentOrganization?.id ?? null);

  if (isLoading) {
    return (
      <div className="grid min-w-0 gap-6">
        <DashboardState
          title="Loading your workspace"
          message="We are loading your organizations and access details."
        />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="grid min-w-0 gap-6">
        <DashboardState
          title="Workspace unavailable"
          message="We could not load your organization access. Please try again later."
          role="alert"
        />
      </div>
    );
  }

  if (!currentOrganization) {
    return (
      <div className="grid min-w-0 gap-6">
        <DashboardState
          title="No organization access"
          message="Your account is signed in, but it is not assigned to an organization yet."
        />
      </div>
    );
  }

  const user = meQuery.data?.user;
  const firstName = getFirstName(user?.displayName, user?.email);
  const members = membersQuery.data ?? [];

  return (
    <div className="grid min-w-0 gap-6">
      <DashboardWelcome
        firstName={firstName}
        organizationName={currentOrganization.name}
      />
      <DashboardSummary
        organization={currentOrganization}
        memberCount={membersQuery.data ? members.length : null}
        role={currentOrganization.role}
      />
      <div className="grid min-w-0 grid-cols-[minmax(0,1.15fr)_minmax(18rem,0.85fr)] items-start gap-5 max-[901px]:grid-cols-[minmax(0,1fr)]">
        <OrganizationOverview organization={currentOrganization} />
        <GettingStarted items={gettingStartedItems} />
      </div>
      {membersQuery.isPending ? (
        <DashboardState
          title="Loading members"
          message="We are loading members for this organization."
        />
      ) : membersQuery.isError ? (
        <DashboardState
          title="Members unavailable"
          message="We could not load the members for this organization."
          role="alert"
        />
      ) : (
        <RecentMembers members={members.slice(0, 3)} />
      )}
    </div>
  );
}
