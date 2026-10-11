import type { JSX } from "react";
import { useAlerts } from "../hooks/use-alerts";
export function AlertSummaryCards({ organizationId }: { organizationId: string | null }): JSX.Element {
  const firing = useAlerts(organizationId, { page: 1, pageSize: 1, signalStatus: "FIRING" });
  const critical = useAlerts(organizationId, { page: 1, pageSize: 1, signalStatus: "FIRING", severity: "CRITICAL" });
  const open = useAlerts(organizationId, { page: 1, pageSize: 1, signalStatus: "FIRING", workflowStatus: "OPEN" });
  return <section aria-label="Organization alert summary" className="grid grid-cols-3 gap-3 max-[640px]:grid-cols-1">{[{ name: "Firing", query: firing, color: "text-retro-red" }, { name: "Critical firing", query: critical, color: "text-retro-red" }, { name: "Unacknowledged firing", query: open, color: "text-retro-cyan" }].map(({ name, query, color }) => <div key={name} className="border-2 border-retro-border bg-retro-surface p-4 shadow-[2px_2px_0_var(--cloudops-shadow)]"><p className="text-xs text-retro-muted">{name}</p><p className={`mt-2 text-3xl font-semibold tabular-nums ${color}`} aria-live="polite">{query.data && !query.isError ? query.data.total : query.isError ? "Unavailable" : "—"}</p></div>)}</section>;
}
