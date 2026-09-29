import {
  PixelAvatar,
  PixelBadge,
  PixelCard,
  PixelDataTable,
  type PixelDataTableProps,
} from "@pxlkit/ui-kit";
import type { Member, MemberStatus, Role } from "../../../types/domain";

const roleLabels: Record<Role, string> = {
  ADMIN: "Administrator",
  OPERATOR: "Operator",
  VIEWER: "Viewer",
};

const statusLabels: Record<MemberStatus, string> = {
  ACTIVE: "Active",
  INVITED: "Invited",
};

function formatRole(role: Role): string {
  return roleLabels[role];
}

function formatStatus(status: MemberStatus): string {
  return statusLabels[status];
}

const columns: PixelDataTableProps<Member>["columns"] = [
  {
    accessorKey: "name",
    header: "Name",
    cell: ({ row }) => (
      <div className="member-cell">
        <PixelAvatar name={row.original.name} size="sm" />
        <span>{row.original.name}</span>
      </div>
    ),
  },
  { accessorKey: "email", header: "Email" },
  {
    accessorKey: "role",
    header: "Role",
    cell: ({ row }) => <PixelBadge tone="cyan">{formatRole(row.original.role)}</PixelBadge>,
  },
  {
    accessorKey: "status",
    header: "Status",
    cell: ({ row }) => (
      <PixelBadge tone="green">{formatStatus(row.original.status)}</PixelBadge>
    ),
  },
];

export function RecentMembers({ members }: { members: Member[] }) {
  return (
    <section className="dashboard-section recent-members">
      <PixelCard title="Recent members">
        <PixelDataTable<Member>
          data={members}
          columns={columns}
          density="comfortable"
          bordered
          stickyHeader
        />
      </PixelCard>
    </section>
  );
}
