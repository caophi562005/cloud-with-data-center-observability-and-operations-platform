import type { JSX } from "react";
import { Link } from "react-router-dom";
import type { Member } from "../../../types/domain";
import type { AlertDetail } from "../alert.types";
import { alertActorLabel } from "../lib/alert-utils";
export function AlertOverview({ alert, members }: { alert: AlertDetail; members: readonly Member[] }): JSX.Element {
  const timestamps = [{ label: "Source started", value: alert.startsAt }, { label: "Source resolved", value: alert.endsAt }, { label: "Received", value: alert.createdAt }, { label: "Acknowledged", value: alert.acknowledgedAt }];
  return <section aria-label="Alert overview" className="space-y-4"><dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-3 text-sm"><dt className="text-retro-muted">Resource</dt><dd className="break-all">{alert.vmHostname} <Link className="text-retro-cyan underline underline-offset-4 focus-visible:outline-2" to={`/vms/${encodeURIComponent(alert.vmId)}`}>View VM</Link></dd><dt className="text-retro-muted">Organization</dt><dd className="break-all">{alert.organizationId}</dd>{timestamps.map(({ label, value }) => <div key={label} className="contents"><dt className="text-retro-muted">{label}</dt><dd>{value ? <time dateTime={value} title={value}>{new Date(value).toLocaleString()}</time> : "—"}</dd></div>)}<dt className="text-retro-muted">Acknowledged by</dt><dd className="break-all">{alert.acknowledgedBy ? alertActorLabel(alert.acknowledgedBy, members) : "—"}</dd></dl>
    {alert.annotations.summary ? <p className="break-words text-sm">{alert.annotations.summary}</p> : null}{alert.annotations.description ? <p className="break-words text-sm text-retro-muted">{alert.annotations.description}</p> : null}
    {[{ name: "Labels", data: alert.labels }, { name: "Annotations", data: alert.annotations }].map(({ name, data }) => <details key={name} className="border-2 border-retro-border p-3"><summary className="cursor-pointer text-sm focus-visible:outline-2">{name} ({Object.keys(data).length})</summary><dl className="mt-3 space-y-3 text-xs">{Object.entries(data).map(([key, value]) => <div key={key}><dt className="break-all font-semibold text-retro-muted">{key}</dt><dd className="mt-1 whitespace-pre-wrap break-words">{value}</dd></div>)}</dl></details>)}
  </section>;
}
