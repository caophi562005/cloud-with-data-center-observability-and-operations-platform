import { useCallback, useId, useRef, useState, type JSX } from 'react';
import { Link } from 'react-router-dom';
import { PixelBadge, PixelButton, PixelIconButton, PixelPopover } from '@pxlkit/ui-kit';
import { useTenant } from '../../../app/providers/app-providers';
import { PxlKitIcon } from '../../../components/ui/pxlkit-icon';
import { useAlerts, useAlertCooldown } from '../hooks/use-alerts';
import { useAlertDrawer } from '../hooks/use-alert-drawer';
import { alertCountBadge } from '../lib/alert-utils';
import { AlertStatusBadges } from './alert-status-badges';
export function AlertBell(): JSX.Element {
  const tenant = useTenant(); const drawer = useAlertDrawer(); const org = tenant.currentOrganization?.id ?? null;
  const [scope, setScope] = useState({ org, open: false }); if (scope.org !== org) setScope({ org, open: false });
  const open = scope.org === org && scope.open && drawer.listReady && !drawer.selection;
  const count = useAlerts(org, { page: 1, pageSize: 1, signalStatus: 'FIRING', workflowStatus: 'OPEN' }, drawer.listReady);
  const preview = useAlerts(org, { page: 1, pageSize: 6, signalStatus: 'FIRING', workflowStatus: 'OPEN', sort: 'severity_desc' }, open);
  const countCooldown = useAlertCooldown(count.error); const previewCooldown = useAlertCooldown(preview.error); const cooldown = countCooldown || previewCooldown;
   const trigger = useRef<HTMLElement | null>(null); const handoff = useRef(false); const id = useId();
  const changeOpen = (value: boolean) => { setScope({ org, open: value }); if (!value && !handoff.current) setTimeout(() => trigger.current?.focus(), 0); handoff.current = false; };
  const focusPanel = useCallback((node: HTMLDivElement | null) => { node?.querySelector<HTMLElement>('button:not(:disabled),a')?.focus(); }, []);
  const badge = count.data && !count.isError ? alertCountBadge(count.data.total) : null;
  const label = !org ? 'Alerts: select an organization' : count.isError ? 'Alerts: count unavailable' : count.data ? `Alerts: ${count.data.total} unacknowledged firing alerts` : 'Alerts: loading count';
  return <PixelPopover open={open} onOpenChange={changeOpen} side="bottom" align="end">
    <PixelPopover.Trigger ref={trigger}><PixelIconButton type="button" data-alert-bell-trigger label={label} disabled={!org || !drawer.listReady} aria-controls={open ? id : undefined} icon={<span className="relative inline-flex"><PxlKitIcon name="bell" />{badge ? <span aria-hidden="true" className="absolute -right-3 -top-3 min-w-4 border border-retro-border bg-retro-red px-1 text-[10px] leading-4 text-white">{badge}</span> : null}</span>} /></PixelPopover.Trigger>
    <span className="sr-only" role="status" aria-live="polite">{label}</span>
    <PixelPopover.Content id={id} ref={focusPanel} aria-label="Unacknowledged firing alerts" className="w-[min(400px,calc(100vw-24px))] max-h-[min(600px,80dvh)] overflow-y-auto">
      <div className="mb-3 flex items-center justify-between gap-3"><h2 className="font-semibold">Unacknowledged firing alerts</h2>{count.data && !count.isError ? <PixelBadge size="sm">{count.data.total}</PixelBadge> : null}</div>
      {preview.isLoading ? <p role="status" className="py-4 text-sm text-retro-muted">Loading alerts…</p> : null}
      {preview.isError ? <div role="alert" className="space-y-2"><p className="text-sm">Alert preview unavailable. Check your session or retry.</p><PixelButton type="button" size="sm" variant="ghost" disabled={cooldown || preview.isFetching || count.isFetching} onClick={() => { if (!cooldown) { void count.refetch(); void preview.refetch(); } }}>Retry preview</PixelButton></div> : null}
      {preview.data && !preview.isError ? preview.data.items.length ? <ul className="divide-y-2 divide-retro-border">{preview.data.items.map((alert) => <li key={alert.id} className="py-3"><PixelButton type="button" size="sm" variant="ghost" aria-label={`Open alert ${alert.alertName} on ${alert.vmHostname}`} onClick={() => { handoff.current = true; changeOpen(false); drawer.openAlert({ organizationId: alert.organizationId, alertId: alert.id }, trigger.current ?? undefined); }}>{alert.alertName}</PixelButton><p className="mt-1 truncate text-xs text-retro-muted" title={alert.vmHostname}>{alert.vmHostname}</p><div className="mt-2"><AlertStatusBadges {...alert} /></div><time dateTime={alert.startsAt} title={alert.startsAt} className="mt-2 block text-xs text-retro-muted">{new Date(alert.startsAt).toLocaleString()}</time></li>)}</ul> : <p className="py-5 text-sm text-retro-muted">No unacknowledged firing alerts.</p> : null}
      <Link to="/alerts?workflowStatus=OPEN&page=1" className="mt-3 block border-t-2 border-retro-border pt-3 text-sm text-retro-cyan underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-retro-cyan" onClick={() => changeOpen(false)}>View all alerts</Link>
    </PixelPopover.Content>
  </PixelPopover>;
}
