import { useState, type ReactNode } from "react";
import { PixelBadge, PixelButton, PixelTabs } from "@pxlkit/ui-kit";
import { Link } from "react-router-dom";
import { integrationDetailPath } from "../lib/integration-route";
import { formatLocalDateTime, getBrowserTimeZone } from "../../../lib/date-time";
import { useAgentStatus, useMonitoringCatalog, useVmMonitoringConfig } from "../hooks/use-monitoring";
import { canManageAgent } from "../lib/agent-connect";
import type { IntegrationInstance, IntegrationObservation, SupportedAgentOs } from "../monitoring.types";
import type { Vm, VmTelemetryMetadata } from "../vm.types";
import { MonitoringSettingsModal } from "./monitoring-settings-modal";
import { collectorLabel } from "../lib/collector-label";
import { PublicValue, RelativeTime } from "./vm-detail-presentation";

interface Props {
  organizationId: string; role: string | undefined; vm: Vm;
  header: ReactNode; overview: ReactNode; inventory: ReactNode; agentActions: ReactNode;
  telemetry: VmTelemetryMetadata; lastSeenAt: string | null; metricsUnavailable: boolean;
  tab: string; onTabChange: (tab: string) => void;
}
const date = (value: string | null | undefined) => value && Number.isFinite(Date.parse(value)) ? formatLocalDateTime(value) : "Not reported";
function target(instance: IntegrationInstance): string {
  switch (instance.kind) {
    case "redis": case "mysql": return `${instance.settings.host}:${instance.settings.port}`;
    case "postgresql": return `${instance.settings.host}:${instance.settings.port} / ${instance.settings.database}`;
    case "nginx": return instance.settings.statusUrl;
    case "docker": return instance.settings.endpoint;
  }
}
function sampleLabel(instance: IntegrationInstance, observation: IntegrationObservation | undefined, unavailable: boolean): string {
  if (!instance.enabled || observation?.state === "disabled" || observation?.availability === "disabled") return "Disabled";
  if (unavailable || observation?.availability === "unavailable" || observation?.availability === "unsupported") return "Unavailable";
  if (observation?.availability === "available" && observation.state === "observed") return "Fresh sample";
  if (observation?.state === "stale") return "Stale";
  return "No sample";
}

/** Scope-keyed lifetime resets the session only when tenant, VM, role or OS changes. */
export function VmMonitoringSection(props: Props) {
  return <MonitoringSectionSession key={`${props.organizationId}:${props.vm.id}:${props.role ?? ""}:${props.vm.osType}`} {...props} />;
}
function MonitoringSectionSession({ organizationId, role, vm, header, overview, inventory, agentActions, telemetry, lastSeenAt, metricsUnavailable, tab, onTabChange }: Props) {
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
  const editable = Boolean(managed && catalog && os && catalog.host.supportedOs.includes(os) && canManageAgent(role) && !denied && catalogQuery.error?.statusCode !== 403 && catalogQuery.error?.statusCode !== 404);
  const readOnlyReason = !native
    ? "Legacy or unknown collector: monitoring is read-only. Explicitly re-enroll a supported native Telegraf agent; no automatic migration is performed."
    : !os ? "Unknown operating system: no native OS preset can be edited."
      : config && !managed ? "No managed native definition is available. Empty defaults cannot be saved."
        : !canManageAgent(role) ? "Read-only access. Admin or Operator role is required to configure monitoring."
          : catalog && !catalog.host.supportedOs.includes(os) ? "This OS is not supported by the native catalog."
            : !config ? "Monitoring definition is not available yet." : !catalog ? "Monitoring catalog is not available yet." : null;
  const instances = config?.definition?.integrations;
  const configSummary = !status ? "Unknown" : status.configState === "applied" ? `Applied${status.appliedVersion === null ? "" : ` v${status.appliedVersion}`}`
    : status.configState === "pending" ? `Pending${status.desiredVersion === null ? "" : ` v${status.desiredVersion}`}`
      : status.configState === "rejected" ? `Rejected${status.rejectedVersion === null ? "" : ` v${status.rejectedVersion}`}` : "Unknown";
  const delivery = metricsUnavailable ? "unknown" : telemetry.telemetryDelivery === "fresh" ? "fresh" : telemetry.telemetryDelivery === "stale" ? "stale" : "unknown";
  const contact = status ? status.lastControlContactAt : telemetry.lastControlContactAt;
  const configurationErrors = <>
    {configQuery.isPending ? <p role="status" className="text-sm text-retro-muted">Loading monitoring definition…</p> : null}
    {configQuery.isError ? <div role="alert" className="flex flex-wrap items-center gap-3 border border-retro-red p-3 text-sm text-retro-text"><p>{configQuery.error.statusCode === 403 ? "Access denied to monitoring configuration." : configQuery.error.statusCode === 404 ? "VM or monitoring definition not found." : "Monitoring configuration could not be refreshed. Displayed settings are the last fetched snapshot."}</p><PixelButton type="button" tone="neutral" variant="ghost" size="sm" onClick={() => void configQuery.refetch()}>Retry definition</PixelButton></div> : null}
    {catalogQuery.isError ? <p role="alert" className="text-sm text-retro-muted">Catalog unavailable. <PixelButton type="button" tone="neutral" variant="ghost" size="sm" onClick={() => void catalogQuery.refetch()}>Retry catalog</PixelButton></p> : null}
  </>;
  const statusNotice = statusQuery.isError ? <p role="status" className="text-sm text-retro-muted">Agent observations unavailable; this is not a service failure. <PixelButton type="button" tone="neutral" variant="ghost" size="sm" onClick={() => void statusQuery.refetch()}>Retry status</PixelButton></p> : statusQuery.isPending ? <p role="status" className="text-sm text-retro-muted">Loading agent status…</p> : null;
  const integrations = <section className="space-y-3" aria-labelledby="vm-integrations-heading">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 id="vm-integrations-heading" className="text-lg font-semibold text-retro-text">Integrations{instances ? ` (${instances.length})` : ""}</h2>{editable && (instances?.length ?? 0) < 16 ? <Link to={`/vms/${encodeURIComponent(vm.id)}/integrations/new`} className="text-retro-cyan underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-retro-cyan">Add integration</Link> : null}</div>
    {configurationErrors}{statusNotice}
    {readOnlyReason ? <p className="text-sm text-retro-muted">{readOnlyReason}</p> : null}
    {instances?.length ? <table role="table" className="vm-integration-table w-full table-fixed border border-retro-border bg-retro-surface text-left text-sm">
      <caption className="sr-only">Configured integration targets and metric sample observations. Samples are not service health or target revision confirmation.</caption>
      <thead role="rowgroup" className="text-retro-muted"><tr role="row"><th role="columnheader" scope="col" className="w-[35%]">Type / target</th><th role="columnheader" scope="col" className="w-[17%]">Collection</th><th role="columnheader" scope="col" className="w-[16%]">Sample status</th><th role="columnheader" scope="col" className="w-[14%]">Last sample</th><th role="columnheader" scope="col" className="w-[18%]">Actions</th></tr></thead>
      <tbody role="rowgroup">{instances.map((instance) => {
        const entry = catalog?.integrations.find((candidate) => candidate.kind === instance.kind);
        const observation = status?.integrations.find((item) => item.instanceId === instance.id);
        const label = sampleLabel(instance, observation, !status);
        return <tr role="row" key={instance.id}>
          <th role="rowheader" scope="row" className="min-w-0 font-normal"><span className="font-semibold text-retro-text">{entry?.title ?? instance.kind}</span><span className="mt-1 block truncate font-mono text-xs text-retro-muted" title={target(instance)}>{target(instance)}</span></th>
          <td role="cell" data-label="Collection"><span>{instance.enabled ? "Enabled" : "Disabled"}</span><span className="block text-xs text-retro-muted">Every {instance.intervalSeconds}s</span></td>
          <td role="cell" data-label="Sample status"><PixelBadge tone={label === "Fresh sample" ? "green" : label === "Stale" ? "gold" : "neutral"} variant="soft" size="sm">{label}</PixelBadge></td>
          <td role="cell" data-label="Last sample"><RelativeTime value={observation?.lastSampleAt} /></td>
          <td role="cell" data-label="Actions"><div className="flex flex-wrap gap-1"><Link to={integrationDetailPath(vm.id, instance.id)} className="inline-flex items-center px-2 py-1 text-retro-cyan underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-retro-cyan" aria-label={`Details for ${entry?.title ?? instance.kind} at ${target(instance)}`}>Details</Link>{editable ? <Link to={`${integrationDetailPath(vm.id, instance.id)}?tab=configuration`} className="inline-flex items-center px-2 py-1 text-retro-cyan underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-retro-cyan" aria-label={`Edit ${entry?.title ?? instance.kind} configuration at ${target(instance)}`}>Edit</Link> : null}</div></td>
        </tr>;
      })}</tbody>
    </table> : instances ? <p className="border border-retro-border bg-retro-surface p-4 text-sm text-retro-muted">No service instances configured. Host telemetry remains enabled.</p> : null}
    <p className="text-xs text-retro-muted">Samples belong to stable instance IDs, not confirmed endpoint revisions or service health.</p>
  </section>;
  const agent = <section className="space-y-4" aria-labelledby="vm-agent-heading">
    <h2 id="vm-agent-heading" className="text-lg font-semibold text-retro-text">Agent &amp; configuration</h2>
    {configurationErrors}{statusNotice}
    <div className="grid gap-3 md:grid-cols-2">
      <div className="space-y-3 border border-retro-border bg-retro-surface p-4"><h3 className="font-semibold text-retro-text">Agent</h3><dl className="grid gap-3 sm:grid-cols-2"><div><dt className="text-sm text-retro-muted">Credential</dt><dd className="text-sm text-retro-text">{vm.agentStatus ?? "Not reported"}</dd></div><div><dt className="text-sm text-retro-muted">Collector</dt><dd className="text-sm text-retro-text">{collectorLabel(status ? status.collectorType : telemetry.collectorType, status ? status.collectorVersion : telemetry.collectorVersion)}</dd></div><div><dt className="text-sm text-retro-muted">Control contact</dt><dd className="text-sm text-retro-text"><RelativeTime value={contact} /></dd></div><div><dt className="text-sm text-retro-muted">Metrics delivery</dt><dd className="text-sm capitalize text-retro-text">{delivery}</dd></div></dl><p className="text-xs text-retro-muted">An active credential or API contact does not establish metric delivery or host health.</p><div className="flex flex-wrap gap-2 border-t border-retro-border pt-3">{agentActions}</div></div>
      <div className="space-y-3 border border-retro-border bg-retro-surface p-4"><h3 className="font-semibold text-retro-text">Configuration</h3><dl className="grid gap-3 sm:grid-cols-2"><div><dt className="text-sm text-retro-muted">Backend state</dt><dd className="text-sm font-semibold text-retro-text">{configSummary}</dd></div><div><dt className="text-sm text-retro-muted">Desired / applied version</dt><dd className="text-sm text-retro-text">{status?.desiredVersion ?? "Unknown"} / {status?.appliedVersion ?? "Unknown"}</dd></div><div><dt className="text-sm text-retro-muted">Last application ACK</dt><dd className="text-sm text-retro-text"><RelativeTime value={status?.lastAppliedAt} /></dd></div><div><dt className="text-sm text-retro-muted">Host gather interval</dt><dd className="text-sm text-retro-text">{config?.definition ? `${config.definition.host.intervalSeconds}s` : "Unknown"}</dd></div></dl><p className="text-xs text-retro-muted">Backend state uses version and hash. An applied ACK is not plugin or service health.</p>{status?.configState === "rejected" ? <p role="alert" className="text-sm text-retro-red">Agent reported a configuration rejection. Inspect local configuration safely; raw diagnostics are hidden.</p> : null}{editable ? <PixelButton type="button" tone="cyan" size="sm" variant="ghost" onClick={() => setEditing(true)}>Edit host interval</PixelButton> : null}{config?.definition && config.definition.host.intervalSeconds > 300 ? <p className="text-sm text-retro-gold">Gathering exceeds the five-minute freshness window. Values and network rates may be unavailable between samples; alerts are delayed.</p> : null}{readOnlyReason ? <p className="text-sm text-retro-muted">{readOnlyReason}</p> : null}</div>
    </div>
    <details className="border border-retro-border bg-retro-surface p-4"><summary className="cursor-pointer font-semibold text-retro-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-retro-cyan">Technical details</summary><div className="mt-4 space-y-4"><dl className="grid min-w-0 gap-4 sm:grid-cols-2">
      <PublicValue label="Agent ID" value={status ? status.agentId : vm.agent?.id} />
      <PublicValue label="Desired hash" value={status?.desiredHash} />
      <PublicValue label="Applied hash" value={status?.appliedHash} />
      <PublicValue label="Last rejected hash" value={status?.rejectedHash} />
      <div><dt className="text-sm text-retro-muted">Last rejected version (historical)</dt><dd className="text-sm text-retro-text">{status?.rejectedVersion ?? "Not reported"}</dd></div>
      <div><dt className="text-sm text-retro-muted">Reported rejection</dt><dd className="text-sm text-retro-text">{status?.rejectedError ? "A rejection was reported; diagnostic text is hidden. This may be historical, not a current failure." : "None reported"}</dd></div>
      <PublicValue label="Collector full version" value={status ? status.collectorVersion : telemetry.collectorVersion} />
      <PublicValue label="Collector build ID" value={status ? status.buildId : telemetry.buildId} />
      <div><dt className="text-sm text-retro-muted">Native host state</dt><dd className="text-sm text-retro-text">{metricsUnavailable ? "unknown" : telemetry.hostState}</dd></div>
      <div><dt className="text-sm text-retro-muted">Telemetry compatibility / delivery</dt><dd className="text-sm text-retro-text">{telemetry.telemetryCompatibility} / {metricsUnavailable ? "unknown" : telemetry.telemetryDelivery}</dd></div>
      <div><dt className="text-sm text-retro-muted">Desired definition version</dt><dd className="text-sm text-retro-text">{config?.version ?? "Not reported"}</dd></div>
      <div><dt className="text-sm text-retro-muted">Application ACK ({getBrowserTimeZone()})</dt><dd className="text-sm text-retro-text">{date(status?.lastAppliedAt)}</dd></div>
      <div><dt className="text-sm text-retro-muted">Agent API contact ({getBrowserTimeZone()})</dt><dd className="text-sm text-retro-text">{date(contact)}</dd></div>
      <div><dt className="text-sm text-retro-muted">Last metric delivery ({getBrowserTimeZone()})</dt><dd className="text-sm text-retro-text">{date(lastSeenAt)}</dd></div>
    </dl>{catalog ? <p className="text-sm text-retro-muted">Profile {catalog.host.profileKey} · Native Telegraf {catalog.host.compatibility} · {vm.osType} preset. Source-derived compatibility; runtime collection/serialization {catalog.host.runtimeVerification}.</p> : null}<p className="text-sm text-retro-muted">Status polls every 15s. Host state requires authoritative native telemetry, not retained inventory or API contact. Unsupported platforms remain neutral. Control contact, credentials, configuration ACK and native host telemetry are separate signals. Rejected revisions may remain after a newer revision is applied. Observations can include old target samples and do not confirm a desired revision.</p></div></details>
  </section>;

  return <div className="space-y-4">
    <header className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0 flex-1">{header}</div><div className="space-y-1">{editable ? <Link to={instances?.[0] ? `${integrationDetailPath(vm.id, instances[0].id)}?tab=configuration` : `/vms/${encodeURIComponent(vm.id)}/integrations/new`} className="inline-flex px-3 py-2 text-retro-cyan underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-retro-cyan">Configure integration</Link> : null}{!editable ? <p className="max-w-60 text-xs text-retro-muted">{readOnlyReason}</p> : null}</div></header>
    <dl className="flex flex-wrap gap-x-6 gap-y-2 border-y border-retro-border py-3 text-sm"><div className="flex flex-wrap gap-2"><dt className="text-retro-muted">Metrics delivery</dt><dd className="text-retro-text"><span className="capitalize">{delivery}</span> · <RelativeTime value={lastSeenAt} /></dd></div><div className="flex flex-wrap gap-2"><dt className="text-retro-muted">Agent contact</dt><dd className="text-retro-text"><RelativeTime value={contact} /></dd></div><div className="flex flex-wrap gap-2"><dt className="text-retro-muted">Config</dt><dd className="text-retro-text">{configSummary}</dd></div></dl>
    <div className="vm-main-tabs min-w-0"><PixelTabs value={tab} onChange={onTabChange} keepMounted>
      <PixelTabs.List className="vm-section-tablist" ariaLabel="Virtual machine sections"><PixelTabs.Trigger value="overview">Overview</PixelTabs.Trigger><PixelTabs.Trigger value="integrations">Integrations{instances ? ` (${instances.length})` : ""}</PixelTabs.Trigger><PixelTabs.Trigger value="agent">Agent &amp; config</PixelTabs.Trigger><PixelTabs.Trigger value="inventory">Inventory</PixelTabs.Trigger></PixelTabs.List>
      <PixelTabs.Panel value="overview">{overview}</PixelTabs.Panel><PixelTabs.Panel value="integrations">{integrations}</PixelTabs.Panel><PixelTabs.Panel value="agent">{agent}</PixelTabs.Panel><PixelTabs.Panel value="inventory">{inventory}</PixelTabs.Panel>
    </PixelTabs></div>
    {editing && editable && config && catalog && os ? <MonitoringSettingsModal organizationId={organizationId} vmId={vm.id} role={role} os={os} initial={config} catalog={catalog} onClose={() => setEditing(false)} /> : null}
  </div>;
}
