import { useState } from "react";
import { PixelBadge, PixelButton } from "@pxlkit/ui-kit";
import { formatLocalDateTime, getBrowserTimeZone } from "../../../lib/date-time";
import { useAgentStatus, useMonitoringCatalog, useVmMonitoringConfig } from "../hooks/use-monitoring";
import { canManageAgent } from "../lib/agent-connect";
import type { IntegrationInstance, SupportedAgentOs } from "../monitoring.types";
import type { Vm } from "../vm.types";
import { MonitoringSettingsModal } from "./monitoring-settings-modal";

interface Props { organizationId: string; role: string | undefined; vm: Vm }
const date = (value: string | null | undefined) => value && Number.isFinite(Date.parse(value)) ? formatLocalDateTime(value) : "Not reported";
function target(instance: IntegrationInstance): string {
  switch (instance.kind) {
    case "redis": case "mysql": return `${instance.settings.host}:${instance.settings.port}`;
    case "postgresql": return `${instance.settings.host}:${instance.settings.port} / ${instance.settings.database}`;
    case "nginx": return instance.settings.statusUrl;
    case "docker": return instance.settings.endpoint;
  }
}

/** Scope-keyed lifetime also resets open state when tenant, VM, role or OS changes. */
export function VmMonitoringSection(props: Props) {
  return <MonitoringSectionSession key={`${props.organizationId}:${props.vm.id}:${props.role ?? ""}:${props.vm.osType}`} {...props} />;
}
function MonitoringSectionSession({ organizationId, role, vm }: Props) {
  const [editing, setEditing] = useState(false);
  const configQuery = useVmMonitoringConfig(organizationId, vm.id);
  const catalogQuery = useMonitoringCatalog(organizationId);
  const statusQuery = useAgentStatus(organizationId, vm.id);
  const denied = configQuery.error?.statusCode === 403 || configQuery.error?.statusCode === 404;
  const config = denied ? undefined : configQuery.data;
  const status = statusQuery.isError ? undefined : statusQuery.data;
  const catalog = catalogQuery.data;
  const os: SupportedAgentOs | null = vm.osType === "Linux" ? "linux" : vm.osType === "Windows" ? "windows" : null;
  const native = vm.collectorType === "TELEGRAF" && vm.telemetryCompatibility === "native";
  const managed = Boolean(native && os && config?.managed && config.definition && config.version !== null);
  const editable = Boolean(managed && catalog && os && catalog.host.supportedOs.includes(os) && canManageAgent(role) && !denied);
  const readOnlyReason = !native
    ? "Legacy or unknown collector: monitoring is read-only. Re-enroll a supported native Telegraf agent explicitly; no migration or empty default save is performed here."
    : !os ? "Unknown operating system: no native OS preset can be edited."
      : config && !managed ? "No managed native definition is available. Empty defaults are not editable or saved."
        : !canManageAgent(role) ? "Viewer / read-only access. Only Admin and Operator may save; the backend enforces vm.manage permission."
          : catalog && os && !catalog.host.supportedOs.includes(os) ? "This OS is not supported by the native catalog." : null;

  return <section aria-labelledby="vm-monitoring-heading" className="space-y-4 border-2 border-retro-border bg-retro-surface p-4 shadow-[3px_3px_0_var(--cloudops-shadow)]">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 id="vm-monitoring-heading" className="text-lg font-semibold text-retro-text">Monitoring settings</h2><p className="mt-1 text-sm text-retro-muted">Desired configuration, agent application and metric observations are separate signals.</p></div>
      <PixelButton type="button" tone="cyan" disabled={!editable} onClick={() => setEditing(true)} title={readOnlyReason ?? (!catalog ? "Monitoring catalog is unavailable" : undefined)}>Edit monitoring settings</PixelButton>
    </div>
    {readOnlyReason ? <p className="text-sm text-retro-muted">{readOnlyReason}</p> : null}
    {configQuery.isPending ? <p role="status" className="text-sm text-retro-muted">Loading monitoring definition…</p> : null}
    {configQuery.isError ? <div role="alert" className="flex flex-wrap items-center gap-3 border border-retro-red p-3 text-sm text-retro-text"><p>{configQuery.error.statusCode === 403 ? "Access denied to monitoring configuration (vm.read required)." : configQuery.error.statusCode === 404 ? "VM or monitoring definition not found." : "Monitoring configuration could not be refreshed. Any displayed definition is the last fetched snapshot."}</p><PixelButton type="button" tone="neutral" variant="ghost" size="sm" onClick={() => void configQuery.refetch()}>Retry definition</PixelButton></div> : null}
    {catalogQuery.isError ? <div role="alert" className="text-sm text-retro-muted">Catalog could not be refreshed. <PixelButton type="button" tone="neutral" variant="ghost" size="sm" onClick={() => void catalogQuery.refetch()}>Retry catalog</PixelButton></div> : null}
    {catalog ? <p className="text-xs text-retro-muted">Profile {catalog.host.profileKey} · Native Telegraf {catalog.host.compatibility} · {os ?? "unsupported OS"} preset · Source-derived compatibility; runtime collection/serialization {catalog.host.runtimeVerification}.</p> : null}
    {config?.definition ? <div className="space-y-3">
      <p className="text-sm text-retro-text">Desired definition version {config.version ?? "unknown"} · Host interval {config.definition.host.intervalSeconds}s · {config.definition.integrations.length}/16 integration instances</p>
      {config.definition.host.intervalSeconds > 300 ? <p className="text-xs text-retro-gold">Host gathering exceeds the five-minute freshness/query window: fields may be unknown and network rates unavailable between samples; alert responsiveness is not preserved.</p> : null}
      {config.definition.integrations.length ? <ul className="space-y-3">{config.definition.integrations.map((instance) => {
        const entry = catalog?.integrations.find((candidate) => candidate.kind === instance.kind);
        const observation = status?.integrations.find((item) => item.instanceId === instance.id);
        const configured = config.secretConfigured[instance.id] ?? {};
        return <li key={instance.id} className="min-w-0 space-y-2 border border-retro-border p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold text-retro-text">{entry?.title ?? instance.kind}</h3><PixelBadge tone="neutral" variant="soft">Desired: {instance.enabled ? "enabled" : "disabled"}</PixelBadge><span className="text-xs text-retro-muted">Gather {instance.intervalSeconds}s · inputs.{entry?.plugin ?? instance.kind} · {entry?.compatibility ?? "compatibility unknown"}</span></div>
          <p className="break-all font-mono text-xs text-retro-muted">Instance {instance.id} · {target(instance)}</p>
          <p className="text-xs text-retro-muted">Credentials: {Object.keys(configured).length ? Object.entries(configured).map(([field, isConfigured]) => `${field}: ${isConfigured ? "configured" : "not configured"}`).join(" · ") : "No credential state reported"}. Values are never returned.</p>
          <dl className="grid gap-2 text-xs sm:grid-cols-2"><div><dt className="text-retro-muted">Metric observation</dt><dd className="text-retro-text">{observation?.state ?? "unknown"}</dd></div><div><dt className="text-retro-muted">Observation availability</dt><dd className="text-retro-text">{observation?.availability ?? "Not reported"}</dd></div><div><dt className="text-retro-muted">Last integration metric sample ({getBrowserTimeZone()})</dt><dd className="text-retro-text">{date(observation?.lastSampleAt)}</dd></div><div><dt className="text-retro-muted">Freshness window</dt><dd className="text-retro-text">{observation?.freshnessSeconds == null ? "Not reported" : `${observation.freshnessSeconds}s`}</dd></div></dl>
          {entry?.warning ? <p className="text-xs text-retro-gold">{entry.warning}</p> : null}
        </li>;
      })}</ul> : <p className="text-sm text-retro-muted">No service instances configured. Host telemetry remains enabled.</p>}
    </div> : null}
    <div className="space-y-3 border-t border-retro-border pt-4">
      <h3 className="font-semibold text-retro-text">Agent configuration status</h3>
      {statusQuery.isPending ? <p role="status" className="text-sm text-retro-muted">Loading agent status…</p> : null}
      {statusQuery.isError ? <div role="alert" className="text-sm text-retro-muted">Agent status unavailable; this is not a plugin failure or service-health result. <PixelButton type="button" tone="neutral" variant="ghost" size="sm" onClick={() => void statusQuery.refetch()}>Retry status</PixelButton></div> : null}
      {status ? <>
        <p className="text-sm text-retro-text">Configuration state: <strong>{status.configState}</strong>{status.configState === "pending" ? " · Desired revision awaits agent confirmation." : status.configState === "applied" ? " · Agent ACK only, not plugin/service health." : status.configState === "rejected" ? " · Agent rejected a revision; inspect local agent configuration safely." : " · No application conclusion available."}</p>
        <dl className="grid min-w-0 gap-3 text-sm sm:grid-cols-2">
          <div><dt className="text-retro-muted">Desired version / hash</dt><dd className="break-all font-mono text-retro-text">{status.desiredVersion ?? "Not reported"} / {status.desiredHash ?? "Not reported"}</dd></div>
          <div><dt className="text-retro-muted">Applied version / hash</dt><dd className="break-all font-mono text-retro-text">{status.appliedVersion ?? "Not reported"} / {status.appliedHash ?? "Not reported"}</dd></div>
          <div><dt className="text-retro-muted">Rejected version / hash</dt><dd className="break-all font-mono text-retro-text">{status.rejectedVersion ?? "Not reported"} / {status.rejectedHash ?? "Not reported"}</dd></div>
          <div><dt className="text-retro-muted">Application error</dt><dd className="text-retro-text">{status.rejectedError || status.configState === "rejected" ? "Agent reported a configuration rejection. Raw diagnostic text is not displayed." : "None reported"}</dd></div>
          <div><dt className="text-retro-muted">Last config application ACK ({getBrowserTimeZone()})</dt><dd className="text-retro-text">{date(status.lastAppliedAt)}</dd></div>
          <div><dt className="text-retro-muted">Last agent API contact ({getBrowserTimeZone()})</dt><dd className="text-retro-text">{date(status.lastControlContactAt)}</dd></div>
        </dl>
      </> : null}
      <p className="text-xs text-retro-muted">Status polls every 15s. API contact is not AMP metric delivery; applied ACK is not plugin health. An observed metric means a sample exists for a stable instance ID, not that the edited endpoint or desired revision is applied or the service is healthy. Old target samples can remain after editing. Unknown, stale, disabled or unavailable observations are not fabricated failures.</p>
    </div>
    {editing && editable && config && catalog && os ? <MonitoringSettingsModal organizationId={organizationId} vmId={vm.id} role={role} os={os} initial={config} catalog={catalog} onClose={() => setEditing(false)} /> : null}
  </section>;
}
