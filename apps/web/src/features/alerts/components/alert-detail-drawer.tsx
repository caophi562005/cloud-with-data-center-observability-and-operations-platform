import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTenant } from "../../../app/providers/app-providers";
import { ApiError } from "../../../lib/api/api-error";
import { PixelButton, PixelDrawer, useMediaQuery, useToast } from "@pxlkit/ui-kit";
import { useOrganizationMembers } from "../../memberships/hooks/use-members";
import { useAlert, useAcknowledgeAlert, useAddAlertComment, useAlertCooldown, useAlertWriteCooldown, alertEventsQueryOptions } from "../hooks/use-alerts";
import { canManageAlerts } from "../lib/alert-utils";
import { AlertCommentForm } from "./alert-comment-form";
import type { AlertSelection } from "../alert.types";
import { AlertStatusBadges } from "./alert-status-badges";
import { AlertOverview } from "./alert-overview";
import { AlertActivity } from "./alert-activity";
function SelectedDetail({ selection, onClose }: { selection: AlertSelection; onClose(): void }): JSX.Element {
  const mobile = useMediaQuery("(max-width: 640px)"); const detail = useAlert(selection.organizationId, selection.alertId); const members = useOrganizationMembers(selection.organizationId, 300_000); const [eventPage, setEventPage] = useState(1);
  // PxlKit portals swap the first inline mount; re-focus the close action on
  // each actual header mount while retaining the library's Tab trap.
  const focusHeader = useCallback((node: HTMLDivElement | null) => node?.querySelector<HTMLButtonElement>('[aria-label="Close alert detail"]')?.focus(), []);
  const tenant = useTenant(); const client = useQueryClient(); const { toast } = useToast();
  const ack = useAcknowledgeAlert(selection.organizationId, selection.alertId); const comment = useAddAlertComment(selection.organizationId, selection.alertId);
  const ackCooldown = useAlertCooldown(ack.error); const commentCooldown = useAlertCooldown(comment.error); const detailCooldown = useAlertCooldown(detail.error); const persistedWriteCooldown = useAlertCooldown(useAlertWriteCooldown(selection.organizationId, selection.alertId)); const writeCooldown = ackCooldown || commentCooldown || detailCooldown || persistedWriteCooldown;
   const ackInFlight = useRef(false);
  const active = useRef(true); useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const canManage = tenant.currentOrganization?.id === selection.organizationId && canManageAlerts(tenant.currentOrganization.role);
  const writeBlocked = [ack.error, comment.error].some((error) => error && [401,403,404].includes(error.statusCode));
  const uncertain = Boolean(comment.error && (comment.error.statusCode === 0 || comment.error.statusCode >= 500));
  const latestActivity = async () => { const events = await client.fetchQuery({ ...alertEventsQueryOptions(selection.organizationId, selection.alertId, 1), staleTime: 0, retry: false }); if (active.current) setEventPage(Math.max(1, Math.ceil(events.total / 50))); };
  const confirmed = async (title: string) => { if (!active.current) return; await latestActivity().catch(() => undefined); if (active.current) toast.success({ title, message: 'Saved by the API.' }); };
  const terminal = detail.isError && [401,403,404].includes(detail.error.statusCode);
  return <PixelDrawer open onOpenChange={(open) => { if (!open) onClose(); }} side="right" size={mobile ? "full" : "lg"} title={detail.data && !terminal ? detail.data.alertName : "Alert detail"}>
    <PixelDrawer.Header ref={focusHeader}><h2 className="min-w-0 break-words text-base font-semibold">{detail.data && !terminal ? detail.data.alertName : "Alert detail"}</h2><PixelButton type="button" size="sm" variant="ghost" aria-label="Close alert detail" onClick={onClose}>Close</PixelButton></PixelDrawer.Header>
    <PixelDrawer.Body className="space-y-6">
      {detail.isPending ? <p role="status">Loading alert…</p> : null}
      {detail.isError ? <div role="alert"><p>{terminal ? "Alert unavailable for this organization or session." : "Unable to refresh alert detail."}</p><PixelButton type="button" variant="ghost" disabled={detailCooldown || detail.isFetching} onClick={() => { if (!detailCooldown) void detail.refetch(); }}>Retry detail</PixelButton></div> : null}
      {detail.data && !terminal ? <><AlertStatusBadges {...detail.data} />
        {canManage ? <>
          {writeCooldown ? <p role="status">Rate limited. Wait before trying again.</p> : null}
           {writeBlocked ? <p role="alert">Write permission is unavailable. Refresh your session before trying again.</p> : null}
          {detail.data.workflowStatus === 'OPEN' ? <PixelButton type="button" disabled={ack.isPending || writeBlocked || writeCooldown} loading={ack.isPending} aria-busy={ack.isPending} onClick={async () => { if (ackInFlight.current || writeBlocked || writeCooldown) return; ackInFlight.current = true; try { await ack.mutateAsync(); await confirmed('Alert acknowledged'); } catch { /* Safe error below, no optimistic state. */ } finally { ackInFlight.current = false; } }}>{ack.isPending ? 'Acknowledging…' : 'Acknowledge'}</PixelButton> : null}
          {ack.error && !writeBlocked ? <p role="alert">Acknowledgement could not be confirmed. Refresh detail before trying again.</p> : null}
        </> : <p className="text-sm text-retro-muted">Read-only access. Operator or Admin permission is required to acknowledge or comment.</p>}
        <AlertOverview alert={detail.data} members={members.data ?? []} />
        {canManage ? <fieldset disabled={writeBlocked} className="min-w-0"><AlertCommentForm disabled={writeBlocked || writeCooldown} pending={comment.isPending} error={comment.error ? (writeBlocked ? 'Write permission is unavailable.' : 'Comment could not be confirmed.') : null} outcomeUncertain={uncertain} onSubmit={async (input) => { if (writeBlocked || writeCooldown) throw new ApiError(403, 'FORBIDDEN', 'Write permission unavailable.'); await comment.mutateAsync(input); await confirmed('Comment added'); }} /></fieldset> : null}
        {uncertain ? <PixelButton type="button" size="sm" variant="ghost" onClick={async () => { try { await latestActivity(); if (active.current) comment.reset(); } catch { /* Keep uncertain outcome; do not retry POST. */ } }}>Refresh history</PixelButton> : null}
        <AlertActivity organizationId={selection.organizationId} alertId={selection.alertId} page={eventPage} onPageChange={setEventPage} /></> : null}
    </PixelDrawer.Body>
  </PixelDrawer>;
}
export function AlertDetailDrawer({ selection, onClose }: { selection: AlertSelection | null; onClose(): void }): JSX.Element | null {
  return selection ? <SelectedDetail key={`${selection.organizationId}:${selection.alertId}`} selection={selection} onClose={onClose} /> : null;
}
