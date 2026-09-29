import type { NavigationSection } from "./navigation.types";

export const navigationSections: NavigationSection[] = [
  {
    id: "overview",
    items: [
      { id: "dashboard", label: "Dashboard", href: "/dashboard", icon: "dashboard" },
    ],
  },
  {
    id: "manage",
    label: "Manage",
    items: [
      { id: "members", label: "Members", href: "/members", icon: "users" },
      {
        id: "organization",
        label: "Organization",
        href: "/organization",
        icon: "organization",
      },
      { id: "settings", label: "Settings", href: "/settings", icon: "settings" },
    ],
  },
];
