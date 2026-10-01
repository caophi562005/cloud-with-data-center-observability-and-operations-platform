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
        <div className="flex min-w-max items-center gap-3 whitespace-nowrap">
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
    <section className="min-w-0 overflow-x-auto [scrollbar-gutter:stable]">
      <PixelCard
        title="Recent members"
        className="shadow-[4px_4px_0_var(--cloudops-shadow)] [&_header]:border-b-2 [&_header]:border-retro-border [&_table]:min-w-[42rem]"
      >
        {members.length === 0 ? (
          <p className="text-retro-muted [overflow-wrap:anywhere]" role="status">
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
