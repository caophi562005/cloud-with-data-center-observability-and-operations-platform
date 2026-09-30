export type IconName =
  | "cloud"
  | "dashboard"
  | "users"
  | "organization"
  | "settings"
  | "search"
  | "bell"
  | "sun"
  | "moon"
  | "chevron-down"
  | "check"
  | "check-circle"
  | "circle"
  | "user"
  | "menu";

export type NavigationItem = {
  id: string;
  label: string;
  href: string;
  icon: IconName;
  disabled?: boolean;
};

export type NavigationSection = {
  id: string;
  label?: string;
  items: NavigationItem[];
};
