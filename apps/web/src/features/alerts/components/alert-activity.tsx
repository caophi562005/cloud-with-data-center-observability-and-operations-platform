import type { JSX } from "react";
import { PixelButton, PixelPagination } from "@pxlkit/ui-kit";
import { useOrganizationMembers } from "../../memberships/hooks/use-members";
import { useAlertEvents, useAlertCooldown } from "../hooks/use-alerts";
import { alertActorLabel } from "../lib/alert-utils";
const eventNames = { ALERT_FIRING: "Alert firing", ALERT_RESOLVED: "Alert resolved", ACKNOWLEDGED: "Acknowledged", COMMENT_ADDED: "Comment added" };
export function AlertActivity({ organizationId, alertId, page, onPageChange }: { organizationId: string; alertId: string; page: number; onPageChange(page: number): void }): JSX.Element {
  const events = useAlertEvents(organizationId, alertId, page); const members = useOrganizationMembers(organizationId, 300_000);
  const cooldown = useAlertCooldown(events.error);
   const totalPages = Math.max(1, Math.ceil((events.data?.total ?? 0) / 50));
  return <section aria-label="Alert activity" className="space-y-4"><div className="flex items-center justify-between gap-2"><h3 className="text-base font-semibold">Activity</h3><PixelButton type="button" size="sm" variant="ghost" disabled={!events.data || events.isFetching} onClick={() => onPageChange(totalPages)}>Latest</PixelButton></div>
    {events.isPending ? <p role="status">Loading activity…</p> : null}
    {events.isError ? <div role="alert"><p>Activity is unavailable.</p><PixelButton type="button" size="sm" variant="ghost" disabled={cooldown || events.isFetching} onClick={() => { if (!cooldown) void events.refetch(); }}>Retry activity</PixelButton></div> : null}
    {events.data && !(events.isError && [401,403,404].includes(events.error.statusCode)) ? events.data.items.length ? <ol className="space-y-4">{events.data.items.map((event) => <li key={event.id} className="border-l-2 border-retro-border pl-3"><p className="text-sm font-semibold">{eventNames[event.type]}</p><p className="mt-1 break-all text-xs text-retro-muted">{alertActorLabel(event.actorId, members.data ?? [])} · Received <time dateTime={event.createdAt} title={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time></p>{event.sourceTimeKey ? <p className="mt-1 text-xs text-retro-muted">Source time: <time dateTime={event.sourceTimeKey} title={event.sourceTimeKey}>{new Date(event.sourceTimeKey).toLocaleString()}</time></p> : null}{event.message ? <p className="mt-2 whitespace-pre-wrap break-words text-sm">{event.message}</p> : null}</li>)}</ol> : <p className="text-sm text-retro-muted">No recorded activity. Older alerts may have no historical events.</p> : null}
    {events.data && totalPages > 1 ? <PixelPagination page={page} total={totalPages} onChange={onPageChange} ariaLabel="Activity pages" prevLabel="Older" nextLabel="Newer" /> : null}
  </section>;
}
