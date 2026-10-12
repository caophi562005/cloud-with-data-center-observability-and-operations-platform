import { PixelBadge } from "@pxlkit/ui-kit";
import type { JSX } from "react";
import type { AlertSummary } from "../alert.types";
export function AlertStatusBadges({ signalStatus, workflowStatus, severity }: Pick<AlertSummary, "signalStatus" | "workflowStatus" | "severity">): JSX.Element {
  return <span role="group" aria-label="Alert state" className="inline-flex flex-wrap gap-2"><PixelBadge size="sm" tone={severity === "CRITICAL" ? "red" : "gold"}>{severity === "CRITICAL" ? "Critical" : "Warning"}</PixelBadge><PixelBadge size="sm" tone={signalStatus === "FIRING" ? "red" : "green"}>{signalStatus === "FIRING" ? "Firing" : "Resolved"}</PixelBadge><PixelBadge size="sm" tone={workflowStatus === "OPEN" ? "neutral" : "cyan"}>{workflowStatus === "OPEN" ? "Open" : "Acknowledged"}</PixelBadge></span>;
}
