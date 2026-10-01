import { PixelCard } from "@pxlkit/ui-kit";
import type { Organization } from "../../../types/domain";

export function OrganizationOverview({ organization }: { organization: Organization }) {
  return (
    <PixelCard
      title="Organization overview"
      className="shadow-[4px_4px_0_var(--cloudops-shadow)] [&_header]:border-b-2 [&_header]:border-retro-border"
    >
      <dl className="grid grid-cols-2 min-w-0 gap-x-6 gap-y-5 m-0 max-[640px]:grid-cols-1">
        <div className="min-w-0">
          <dt className="text-[0.7rem] font-bold uppercase tracking-[0.08em] leading-tight text-retro-muted">
            Organization Name
          </dt>
          <dd className="m-0 mt-[0.35rem] text-retro-text [overflow-wrap:anywhere]">
            {organization.name}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[0.7rem] font-bold uppercase tracking-[0.08em] leading-tight text-retro-muted">
            Slug
          </dt>
          <dd className="m-0 mt-[0.35rem] text-retro-text [overflow-wrap:anywhere]">
            {organization.slug}
          </dd>
        </div>
      </dl>
    </PixelCard>
  );
}
