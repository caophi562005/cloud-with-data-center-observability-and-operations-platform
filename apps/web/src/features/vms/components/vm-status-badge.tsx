import { PixelBadge } from "@pxlkit/ui-kit";
import type { IconName } from "../../../app/navigation/navigation.types";
import { PxlKitIcon } from "../../../components/ui/pxlkit-icon";
import type { VmStatus } from "../vm.types";
import { STATUS_LABELS, STATUS_TONES } from "../lib/vm-utils";

const STATUS_ICONS: Record<VmStatus, IconName> = {
  HEALTHY: "check-circle",
  WARNING: "warning",
  CRITICAL: "error",
  DISCONNECTED: "close",
};

export function VmStatusBadge({ status }: { status: VmStatus }) {
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
