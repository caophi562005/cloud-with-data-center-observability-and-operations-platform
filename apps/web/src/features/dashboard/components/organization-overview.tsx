import { PixelBadge, PixelCard } from "@pxlkit/ui-kit";
import type { Organization } from "../../../types/domain";

export function OrganizationOverview({ organization }: { organization: Organization }) {
  return (
    <PixelCard title="Organization overview">
      <dl className="organization-overview-grid">
        <div>
          <dt>Organization Name</dt>
          <dd>{organization.name}</dd>
        </div>
        <div>
          <dt>Slug</dt>
          <dd>{organization.slug}</dd>
        </div>
        <div>
          <dt>Plan</dt>
          <dd>
            <PixelBadge tone="cyan" variant="soft">
              {organization.plan}
            </PixelBadge>
          </dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{organization.createdAt}</dd>
        </div>
      </dl>
    </PixelCard>
  );
}
