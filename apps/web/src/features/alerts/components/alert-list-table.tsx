import { PixelBadge, PixelButton, PixelTable } from "@pxlkit/ui-kit";
import type { JSX } from "react";
import type { Member } from "../../../types/domain";
import type { AlertSummary } from "../alert.types";
import { alertActorLabel } from "../lib/alert-utils";
import { AlertStatusBadges } from "./alert-status-badges";
export function AlertListTable({ items, selectedId, onOpen, members }: { items: readonly AlertSummary[]; selectedId: string | null; onOpen(alert: AlertSummary, opener?: HTMLElement): void; members: readonly Member[] }): JSX.Element {
  const open = (row: AlertSummary) => <PixelButton type="button" variant="ghost" tone="neutral" size="sm" aria-current={selectedId === row.id ? "true" : undefined} aria-label={`Open alert ${row.alertName} on ${row.vmHostname}`} onClick={(event) => { event.stopPropagation(); onOpen(row, event.currentTarget); }}>{row.alertName}</PixelButton>;
  return <><div className="hidden overflow-x-auto md:block"><PixelTable<AlertSummary> data={[...items]} density="compact" stickyHeader getRowId={(row) => row.id} onRowClick={(row) => onOpen(row)} columns={[
    { key: "alertName", header: "Alert", render: open }, { key: "severity", header: "Severity", render: (row) => <PixelBadge size="sm" tone={row.severity === "CRITICAL" ? "red" : "gold"}>{row.severity === "CRITICAL" ? "Critical" : "Warning"}</PixelBadge> },
    { key: "signalStatus", header: "Signal", render: (row) => <PixelBadge size="sm" tone={row.signalStatus === "FIRING" ? "red" : "green"}>{row.signalStatus === "FIRING" ? "Firing" : "Resolved"}</PixelBadge> },
    { key: "workflowStatus", header: "Workflow", render: (row) => row.workflowStatus === "OPEN" ? "Open" : "Acknowledged" }, { key: "vmHostname", header: "Resource", render: (row) => <span className="break-all">{row.vmHostname}</span> },
    { key: "startsAt", header: "Started", render: (row) => <time dateTime={row.startsAt} title={row.startsAt}>{new Date(row.startsAt).toLocaleString()}</time> },
    { key: "acknowledgedBy", header: "Acknowledged by", render: (row) => row.acknowledgedBy ? <span>{alertActorLabel(row.acknowledgedBy, members)}{row.acknowledgedAt ? <time className="mt-1 block text-xs text-retro-muted" dateTime={row.acknowledgedAt}>{new Date(row.acknowledgedAt).toLocaleString()}</time> : null}</span> : "—" }
  ]} /></div><ul className="space-y-3 md:hidden" aria-label="Alerts on this page">{items.map((row) => <li key={row.id} className="border-2 border-retro-border bg-retro-surface p-3"><div>{open(row)}</div><p className="mb-3 break-all text-sm text-retro-muted">{row.vmHostname}</p><AlertStatusBadges {...row} /><p className="mt-3 text-xs text-retro-muted"><time dateTime={row.startsAt}>{new Date(row.startsAt).toLocaleString()}</time></p></li>)}</ul></>;
}
