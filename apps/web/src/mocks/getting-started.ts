import type { GettingStartedItem } from "../types/domain";

export const gettingStartedItems: GettingStartedItem[] = [
  {
    id: "organization-created",
    label: "Organization created",
    completed: true,
  },
  {
    id: "administrator-account-configured",
    label: "Administrator account configured",
    completed: true,
  },
  {
    id: "authentication-configured",
    label: "Authentication configured",
    completed: true,
  },
  {
    id: "invite-team-members",
    label: "Invite team members",
    completed: false,
  },
  {
    id: "add-first-monitored-vm",
    label: "Add first monitored VM",
    completed: false,
    comingSoon: true,
  },
];
