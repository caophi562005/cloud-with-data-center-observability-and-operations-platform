import { PxlKitIcon as CorePxlKitIcon, type PxlKitData } from "@pxlkit/core";
import {
  Bell,
  CheckCircle,
  Clock,
  ErrorOctagon,
  InfoCircle,
  WarningTriangle,
  XCircle,
} from "@pxlkit/feedback";
import { User, UserGroup } from "@pxlkit/social";
import { ArrowRight, Check, Copy, Edit, Grid, History, Home, Menu, Search, Settings, Trash } from "@pxlkit/ui";
import { Cloud, Moon, Sun } from "@pxlkit/weather";
import type { IconName } from "../../app/navigation/navigation.types";

type IconDefinition = {
  icon: PxlKitData;
  rotation?: number;
};

const iconDefinitions: Record<IconName, IconDefinition> = {
  cloud: { icon: Cloud },
  dashboard: { icon: Grid },
  users: { icon: UserGroup },
  organization: { icon: Home },
  settings: { icon: Settings },
  search: { icon: Search },
  bell: { icon: Bell },
  sun: { icon: Sun },
  moon: { icon: Moon },
  "chevron-down": { icon: ArrowRight, rotation: 90 },
  check: { icon: Check },
  "check-circle": { icon: CheckCircle },
  circle: { icon: InfoCircle },
  user: { icon: User },
  menu: { icon: Menu },
  "arrow-left": { icon: ArrowRight, rotation: 180 },
  edit: { icon: Edit },
  trash: { icon: Trash },
  close: { icon: XCircle },
  warning: { icon: WarningTriangle },
  error: { icon: ErrorOctagon },
  clock: { icon: Clock },
  copy: { icon: Copy },
  refresh: { icon: History },
};

export function PxlKitIcon({
  name,
  size = 16,
}: {
  name: IconName;
  size?: number;
}) {
  const { icon, rotation } = iconDefinitions[name];

  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-flex",
        lineHeight: 0,
        transform: rotation ? `rotate(${rotation}deg)` : undefined,
      }}
    >
      <CorePxlKitIcon
        icon={icon}
        size={size}
      />
    </span>
  );
}
