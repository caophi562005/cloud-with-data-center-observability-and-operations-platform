import { PixelBadge } from "@pxlkit/ui-kit";
import type { IconName } from "../../../app/navigation/navigation.types";
import { PxlKitIcon } from "../../../components/ui/pxlkit-icon";
import type { VmHostState } from "../vm.types";
import { STATUS_LABELS, STATUS_TONES } from "../lib/vm-utils";

const STATUS_ICONS: Record<VmHostState, IconName> = {
  HEALTHY: "check-circle",
  WARNING: "warning",
  CRITICAL: "error",
  DISCONNECTED: "close",
  unknown: "cloud",
  unsupported: "cloud",
};

export function VmStatusBadge({ status }: { status: VmHostState }) {
  return (
    <PixelBadge
      tone={STATUS_TONES[status]}
      variant="soft"
      size="sm"
      iconLeft={<PxlKitIcon name={STATUS_ICONS[status]} size={13} />}
    >
      {STATUS_LABELS[status]}
    </PixelBadge>
  );
}
