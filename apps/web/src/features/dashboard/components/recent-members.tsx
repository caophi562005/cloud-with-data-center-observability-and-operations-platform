import {
  PixelAvatar,
  PixelBadge,
  PixelCard,
  PixelDataTable,
  type PixelDataTableProps,
} from "@pxlkit/ui-kit";
import type { Member, Role } from "../../../types/domain";

const roleLabels: Record<Role, string> = {
  ADMIN: "Administrator",
  OPERATOR: "Operator",
  VIEWER: "Viewer",
};

function formatRole(role: Role): string {
  return roleLabels[role];
}

function getMemberName(member: Member): string {
  return member.displayName?.trim() || member.email;
}

const columns: PixelDataTableProps<Member>["columns"] = [
  {
    accessorKey: "displayName",
    header: "Name",
    cell: ({ row }) => {
      const name = getMemberName(row.original);

      return (
        <div className="member-cell">
          <PixelAvatar name={name} size="sm" />
          <span>{name}</span>
        </div>
      );
    },
  },
  { accessorKey: "email", header: "Email" },
  {
    accessorKey: "role",
    header: "Role",
    cell: ({ row }) => <PixelBadge tone="cyan">{formatRole(row.original.role)}</PixelBadge>,
  },
];

export function RecentMembers({ members }: { members: Member[] }) {
  return (
    <section className="dashboard-section recent-members">
      <PixelCard title="Recent members">
        {members.length === 0 ? (
          <p className="dashboard-state-copy" role="status">
            No members are assigned to this organization yet.
          </p>
        ) : (
          <PixelDataTable<Member>
            data={members}
            columns={columns}
            density="comfortable"
            bordered
            stickyHeader
          />
        )}
      </PixelCard>
    </section>
  );
}
