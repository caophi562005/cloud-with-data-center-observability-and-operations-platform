import { useEffect } from "react";
import { PixelBadge, PixelButton, PixelEmptyState, PixelTabs } from "@pxlkit/ui-kit";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useTenant } from "../../../app/providers/app-providers";
import { queryKeys } from "../../../lib/query/query-keys";
import { getBrowserTimeZone } from "../../../lib/date-time";
import { isValidVmId, useVm } from "../hooks/use-vms";
import { useAgentStatus, useMonitoringCatalog, useVmMonitoringConfig } from "../hooks/use-monitoring";
import { useIntegrationCurrentMetrics, useIntegrationMetricsHistory } from "../hooks/use-integration-metrics";
import { IntegrationMetricChart } from "../components/integration-metric-chart";
import { IntegrationLatestMetrics } from "../components/integration-latest-metrics";
import { IntegrationConfigEditor } from "../components/integration-config-editor";
import { canManageAgent } from "../lib/agent-connect";
import { PublicValue } from "../components/vm-detail-presentation";
import { featuredIntegrationDefinitions, integrationMetricValue, integrationReadError, integrationSampleTime, integrationTarget, INTEGRATION_STATE_LABELS, INTEGRATION_TITLES } from "../lib/integration-metric-format";
import { INTEGRATION_RANGES, integrationDetailPath, integrationRouteSearch, parseIntegrationRoute, resolveIntegrationSelection, vmIntegrationsPath, type IntegrationRoute, type IntegrationTab } from "../lib/integration-route";
import type { IntegrationMetricDefinition, IntegrationMetricsCurrent, IntegrationMetricsRange } from "../integration-metrics.types";
import type { AgentStatusView, IntegrationInstance, MonitoringConfigView, IntegrationCatalogEntry } from "../monitoring.types";
import "./integration-detail.css";

function MetricHistory({ organizationId, vmId, current, definition, range, requestedEntity }: {
  organizationId: string; vmId: string; current: IntegrationMetricsCurrent; definition: IntegrationMetricDefinition;
  range: IntegrationMetricsRange; requestedEntity: string | null;
}) {
  const selection = resolveIntegrationSelection(current, definition, requestedEntity);
  const historyQuery = useIntegrationMetricsHistory(organizationId, vmId, current.instanceId, {
    range, metric: definition.key, ...(selection.entityKey ? { entity: selection.entityKey } : {}),
  }, selection.canChart && current.dataState !== "unsupported");
  if (current.dataState === "unsupported") return <div className="integration-card" role="status"><h3>{definition.label}</h3><p>History is unsupported for this collector/platform.</p></div>;
  if (!selection.canChart) return <div className="integration-card" role="status"><h3>{definition.label}</h3><p>{selection.requiresEntity ? "No known entity is reported for this metric. A database or container is not inferred from the target." : "History is not available for this metric."}</p></div>;
  if (historyQuery.isError) return <div className="integration-card integration-error" role="alert"><h3>{definition.label}</h3><p>{integrationReadError(historyQuery.error.statusCode, "Metric history")}</p><PixelButton tone="neutral" variant="ghost" size="sm" onClick={() => void historyQuery.refetch()}>Retry {definition.label}</PixelButton></div>;
  if (historyQuery.isPending) return <div className="integration-card" role="status">Loading {definition.label} history for {range}…</div>;
  return historyQuery.data ? <div className="integration-stack"><p className="integration-muted">{selection.entityKey ? selection.entities.find((entity) => entity.key === selection.entityKey)?.label : "Global / no entity"}</p><IntegrationMetricChart definition={definition} history={historyQuery.data} /></div> : null;
}

function IntegrationConfiguration({ instance, config, status, entry, viewer }: {
  instance: IntegrationInstance; config: MonitoringConfigView; status?: AgentStatusView; entry?: IntegrationCatalogEntry; viewer: boolean;
}) {
  const observation = status?.integrations.find((item) => item.instanceId === instance.id);
  const tls = "tls" in instance.settings ? instance.settings.tls : null;
  // Only documented public fields and secret-presence booleans; never serialize a DTO.
  const credentialFields = ["username", "password", "tlsKeyPassword", "oauthClientId", "oauthClientSecret"] as const;
  return <section className="integration-stack" aria-labelledby="integration-configuration-heading">
    <div><h2 id="integration-configuration-heading">Configuration</h2><p className="integration-muted">{viewer ? "Viewer access · " : ""}Canonical server definition and independent application observations. Unsaved edits below are not applied configuration.</p></div>
    <div className="integration-two-columns">
      <section className="integration-card"><h3>Desired collection</h3><dl className="integration-definition-grid">
        <div><dt>Collection</dt><dd>{instance.enabled ? "Enabled" : "Disabled"}</dd></div><div><dt>Gather interval</dt><dd>{instance.intervalSeconds}s</dd></div>
        <div><dt>Definition version</dt><dd>{config.version ?? "Not reported"}</dd></div><div><dt>Plugin / compatibility</dt><dd>inputs.{entry?.plugin ?? instance.kind} / {entry?.compatibility ?? "Not reported"}</dd></div>
        <div><dt>Transport verification</dt><dd>{instance.kind === "postgresql" ? `SSL mode: ${instance.settings.sslMode}` : tls === null ? "Public Docker endpoint definition" : tls ? "TLS enabled" : "TLS disabled"}</dd></div>
        {instance.kind === "postgresql" ? <div><dt>Configured database</dt><dd>{instance.settings.database}</dd></div> : null}
      </dl><details><summary>Public target and instance</summary><dl className="integration-definition-grid"><PublicValue label="Desired target" value={integrationTarget(instance)} /><PublicValue label="Instance ID" value={instance.id} /></dl></details>
        <h4>Credentials configured</h4><dl className="integration-definition-grid">{credentialFields.filter((field) => config.secretConfigured[instance.id]?.[field] !== undefined).map((field) => <div key={field}><dt>{field}</dt><dd>{config.secretConfigured[instance.id]?.[field] ? "Yes" : "No"}</dd></div>)}</dl>{!credentialFields.some((field) => config.secretConfigured[instance.id]?.[field] !== undefined) ? <p className="integration-muted">No credential-presence state reported.</p> : null}
        {instance.intervalSeconds > 300 ? <p className="integration-notice">Gathering exceeds the five-minute freshness window; values and rates can be unavailable between samples.</p> : null}
      </section>
      <section className="integration-card"><h3>Agent application and observation</h3><dl className="integration-definition-grid">
        <div><dt>Backend config state</dt><dd>{status?.configState ?? "Unknown"}</dd></div><div><dt>Desired / applied version</dt><dd>{status?.desiredVersion ?? "Unknown"} / {status?.appliedVersion ?? "Unknown"}</dd></div>
        <div><dt>Application ACK ({getBrowserTimeZone()})</dt><dd>{integrationSampleTime(status?.lastAppliedAt)}</dd></div><div><dt>Control contact ({getBrowserTimeZone()})</dt><dd>{integrationSampleTime(status?.lastControlContactAt)}</dd></div>
        <div><dt>Observed sample state / availability</dt><dd>{observation?.state ?? "Unknown"} / {observation?.availability ?? "Unknown"}</dd></div><div><dt>Source sample</dt><dd>{integrationSampleTime(observation?.lastSampleAt)}</dd></div>
        <div><dt>Freshness window</dt><dd>{observation?.freshnessSeconds == null ? "Not reported" : `${observation.freshnessSeconds}s`}</dd></div>
      </dl>{status?.configState === "rejected" ? <p className="integration-notice" role="alert">Agent reported a configuration rejection. Raw diagnostics are not displayed.</p> : null}
        <details><summary>Public revision details</summary><dl className="integration-definition-grid"><PublicValue label="Desired hash" value={status?.desiredHash} /><PublicValue label="Applied hash" value={status?.appliedHash} /><PublicValue label="Last rejected hash (historical)" value={status?.rejectedHash} /><div><dt>Last rejected version (historical)</dt><dd>{status?.rejectedVersion ?? "Not reported"}</dd></div></dl></details>
      </section>
    </div>
    {entry?.warning ? <p className="integration-notice">{entry.warning}</p> : null}
    <p className="integration-notice">Control contact, applied configuration and metric delivery are separate signals. A sample belongs to the stable instance ID; it does not confirm the current endpoint, desired revision, or service health. Rejection details may be historical.</p>
  </section>;
}

export function IntegrationDetailPage() {
  const { vmId, instanceId } = useParams<{ vmId: string; instanceId: string }>();
  const { currentOrganization } = useTenant();
  if (!currentOrganization) return <PixelEmptyState title="No organization selected" description="Select an organization to view its integration metrics." />;
  if (!vmId || !instanceId || !isValidVmId(vmId) || !isValidVmId(instanceId)) return <PixelEmptyState title="Invalid integration link" description="Choose a configured instance from the VM integrations list." action={<Link to="/vms">Back to VMs</Link>} />;
  return <IntegrationDetailSession key={`${currentOrganization.id}:${vmId}:${instanceId}:${currentOrganization.role}`} organizationId={currentOrganization.id} vmId={vmId} instanceId={instanceId} role={currentOrganization.role} />;
}

function IntegrationDetailSession({ organizationId, vmId, instanceId, role }: { organizationId: string; vmId: string; instanceId: string; role: string }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate(); const client = useQueryClient();
  const route = parseIntegrationRoute(searchParams);
  const vmQuery = useVm(organizationId, vmId);
  const configQuery = useVmMonitoringConfig(organizationId, vmId);
  const catalogQuery = useMonitoringCatalog(organizationId);
  const statusQuery = useAgentStatus(organizationId, vmId);
  const configDenied = configQuery.error?.statusCode === 403 || configQuery.error?.statusCode === 404;
  const config = configDenied ? undefined : configQuery.data;
  const instances = config?.definition?.integrations ?? [];
  const instance = instances.find((item) => item.id === instanceId);
  const currentQuery = useIntegrationCurrentMetrics(organizationId, vmId, instanceId, Boolean(instance) && !vmQuery.isError && Boolean(vmQuery.data));
  const current = currentQuery.isError || !instance || currentQuery.data?.instanceId !== instance.id || currentQuery.data.kind !== instance.kind ? undefined : currentQuery.data;
  const featured = current ? featuredIntegrationDefinitions(current) : [];
  const selectedDefinition = current?.definitions.find((metric) => metric.key === route.metric && metric.chart) ?? featured[0] ?? current?.definitions.find((metric) => metric.chart);
  const selected = current && selectedDefinition ? resolveIntegrationSelection(current, selectedDefinition, route.entity) : undefined;
  const overviewEntity = current?.entities.find((entity) => entity.key === route.entity)?.key ?? null;
  const effectiveRoute = { ...route, metric: selectedDefinition?.key ?? null, entity: route.tab === "overview" ? overviewEntity : selected?.entityKey ?? null };
  const canonicalSearch = integrationRouteSearch(current ? effectiveRoute : route).toString();
  useEffect(() => {
    // Drop unrelated parameters; selectors are only canonicalized once real definitions are known.
    if (current && canonicalSearch !== searchParams.toString()) setSearchParams(canonicalSearch, { replace: true });
  }, [canonicalSearch, current, searchParams, setSearchParams]);
  useEffect(() => () => { void client.cancelQueries({ queryKey: queryKeys.integrationMetrics(organizationId, vmId, instanceId) }); }, [client, organizationId, vmId, instanceId]);
  function changeRoute(patch: Partial<IntegrationRoute>) { setSearchParams(integrationRouteSearch({ ...effectiveRoute, ...patch })); }
  function selectMetric(metric: string, entity: string | null) {
    const definition = current?.definitions.find((item) => item.key === metric && item.chart);
    if (!current || !definition) return;
    const next = resolveIntegrationSelection(current, definition, entity);
    changeRoute({ metric: definition.key, entity: next.entityKey });
  }
  const back = <Link to={vmIntegrationsPath(vmId)} className="integration-back">← Back to VM integrations</Link>;
  if ((vmQuery.isError && (!vmQuery.data || vmQuery.error.statusCode === 403 || vmQuery.error.statusCode === 404)) || (configQuery.isError && (!config || configDenied))) {
    const error = vmQuery.isError ? vmQuery.error : configQuery.error;
    return <div className="integration-detail integration-stack">{back}<PixelEmptyState title="Integration unavailable" description={integrationReadError(error?.statusCode ?? 0, "Integration configuration")} action={<PixelButton tone="neutral" onClick={() => { void vmQuery.refetch(); void configQuery.refetch(); }}>Retry configuration</PixelButton>} /></div>;
  }
  if (vmQuery.isPending || configQuery.isPending) return <div className="integration-detail integration-stack">{back}<p role="status">Loading VM and configured integration…</p></div>;
  if (!instance || !config || !vmQuery.data) return <div className="integration-detail integration-stack">{back}<PixelEmptyState title="Integration not found" description="This instance does not exist in the VM's current server definition, or the collector is not managed." /></div>;
  const entry = catalogQuery.data?.integrations.find((item) => item.kind === instance.kind);
  const os = vmQuery.data.osType === "Linux" ? "linux" : vmQuery.data.osType === "Windows" ? "windows" : null;
  const editable = Boolean(catalogQuery.error?.statusCode !== 403 && catalogQuery.error?.statusCode !== 404 && canManageAgent(role) && config.managed && config.definition && config.version !== null && vmQuery.data.collectorType === "TELEGRAF" && vmQuery.data.telemetryCompatibility === "native" && os && catalogQuery.data?.host.supportedOs.includes(os) && entry?.supportedOs.includes(os));
  const status = statusQuery.isError ? undefined : statusQuery.data;
  const dataState = current?.dataState;
  const title = entry?.title ?? INTEGRATION_TITLES[instance.kind];
  const entityOptions = route.tab === "overview" ? current?.entities ?? [] : selected?.entities ?? [];
  const controls = <div className="integration-controls">
    <label>Time range<select value={route.range} onChange={(event) => changeRoute({ range: event.target.value as IntegrationMetricsRange })}>{INTEGRATION_RANGES.map((range) => <option value={range} key={range}>{range}</option>)}</select></label>
    {entityOptions.length ? <label>Reported entity<select value={(route.tab === "overview" ? overviewEntity : selected?.entityKey) ?? ""} onChange={(event) => changeRoute({ entity: event.target.value || null })}><option value="">Global / metric default</option>{entityOptions.map((entity) => <option key={entity.key} value={entity.key}>{entity.label}</option>)}</select></label> : null}
  </div>;
  const metricsContent = current ? <div className="integration-stack">
    {current.entitiesTruncated ? <p className="integration-notice">Entity results are truncated by the server. Selectors are reported samples, not a complete or live inventory.</p> : null}
    {dataState && dataState !== "fresh" ? <p role="status" className="integration-notice">{INTEGRATION_STATE_LABELS[dataState]}. {dataState === "disabled" ? "Collection is disabled; retained history can be viewed for global metrics and reported entities. Redis keyspace or Docker container history requires a reported entity; missing entities are not inferred." : dataState === "unsupported" ? "This collector/platform is unsupported; no service failure is inferred." : dataState === "stale" ? "Latest source samples are stale, not proof of a current failure." : "No source samples are available; this is not a zero reading."}</p> : null}
    {controls}
    {route.tab === "overview" ? <>
      <div className="integration-kpis">{featured.map((definition) => {
        const selection = resolveIntegrationSelection(current, definition, route.entity);
        const reading = current.readings.find((item) => item.key === definition.key && item.entityKey === selection.entityKey);
        return <section key={definition.key} className="integration-card"><h3>{definition.label}</h3><p className="integration-kpi-value">{integrationMetricValue(reading?.value)} <span>{definition.unit}</span></p><p className="integration-muted">{selection.entityKey ? selection.entities.find((entity) => entity.key === selection.entityKey)?.label : "Global / no entity"}</p><p className="integration-muted">{reading ? INTEGRATION_STATE_LABELS[reading.state] : "No data"} · {integrationSampleTime(reading?.lastSampleAt)}</p>{reading?.reason ? <p className="integration-muted">{reading.reason}</p> : null}<p className="integration-muted">{definition.description}</p></section>;
      })}</div>
      <section className="integration-stack" aria-labelledby="integration-history-heading"><h2 id="integration-history-heading">Metric history</h2><p className="integration-muted">At most four visible histories · {getBrowserTimeZone()} · source rates and ratios are computed by the server.</p><div className="integration-two-columns">{featured.map((definition) => <MetricHistory key={definition.key} organizationId={organizationId} vmId={vmId} current={current} definition={definition} range={route.range} requestedEntity={route.entity} />)}</div>{!featured.length ? <p role="status">No supported featured metrics were returned by this collector.</p> : null}</section>
    </> : <>
      <IntegrationLatestMetrics key={instanceId} current={current} selectedMetric={selectedDefinition?.key ?? null} selectedEntity={selected?.entityKey ?? null} onSelect={selectMetric} />
      {selectedDefinition ? <MetricHistory organizationId={organizationId} vmId={vmId} current={current} definition={selectedDefinition} range={route.range} requestedEntity={route.entity} /> : <p role="status">No chartable metric definitions were returned.</p>}
    </>}
  </div> : currentQuery.isError ? <div role="alert" className="integration-card integration-error"><p>{integrationReadError(currentQuery.error.statusCode, "Current integration metrics")}</p><PixelButton tone="neutral" onClick={() => void currentQuery.refetch()}>Retry current metrics</PixelButton></div> : <p role="status">Loading current integration metrics…</p>;
  return <div className="integration-detail integration-stack" data-testid="integration-detail-page">
    {back}
    <header className="integration-header"><div><div className="integration-title-row"><h1>{title}</h1><PixelBadge tone={dataState === "fresh" ? "cyan" : dataState === "stale" ? "gold" : "neutral"} variant="soft">{dataState ? INTEGRATION_STATE_LABELS[dataState] : currentQuery.isError ? "Metrics unavailable" : "Loading metrics"}</PixelBadge></div><p className="integration-muted">{vmQuery.data.hostname} · {instance.enabled ? "Collection enabled" : "Collection disabled"} · every {instance.intervalSeconds}s</p><p className="integration-target" title={integrationTarget(instance)}>{integrationTarget(instance)}</p></div>
      <div className="integration-header-actions"><label>Switch configured instance<select value={instanceId} onChange={(event) => navigate(`${integrationDetailPath(vmId, event.target.value)}?${integrationRouteSearch({ tab: route.tab, range: route.range, metric: null, entity: null })}`)}>{instances.map((item, index) => <option key={item.id} value={item.id}>{INTEGRATION_TITLES[item.kind]} · {integrationTarget(item).slice(0, 90)} · #{index + 1}</option>)}</select></label><PixelButton tone="neutral" size="sm" onClick={() => { void client.invalidateQueries({ queryKey: queryKeys.integrationMetrics(organizationId, vmId, instanceId) }); void configQuery.refetch(); void statusQuery.refetch(); }}>Refresh</PixelButton></div>
    </header>
    <dl className="integration-signals"><div><dt>Metric source sample</dt><dd>{integrationSampleTime(current?.lastSampleAt)}</dd></div><div><dt>Agent control contact</dt><dd>{integrationSampleTime(status?.lastControlContactAt)}</dd></div><div><dt>Configuration / applied version</dt><dd>{status?.configState ?? "Unknown"} / {status?.appliedVersion ?? "Unknown"}</dd></div></dl>
    <p className="integration-muted">Metric freshness is not service health. Contact, application ACK and sample delivery are separate; samples do not verify the desired target or revision.</p>
    {instance.kind === "docker" ? <p className="integration-notice">Engine counts are daemon-wide, not selected-container counts. Container names/source identities describe sampled lifecycles, not live inventory. Linux CPU may exceed 100%; reported memory limits do not prove a configured hard cap. Windows commit/private accounting and CPU counter units are defined per metric; block I/O bytes are not disk utilization.</p> : instance.kind === "nginx" ? <p className="integration-muted">Native stub-status connection and request counters only; no response-code or p95 latency metrics are inferred.</p> : instance.kind === "postgresql" ? <p className="integration-muted">Only the configured database's reported native fields are selectable.</p> : null}
    {statusQuery.isError ? <p role="alert" className="integration-notice">{integrationReadError(statusQuery.error.statusCode, "Agent observations")} <PixelButton tone="neutral" size="sm" variant="ghost" onClick={() => void statusQuery.refetch()}>Retry status</PixelButton></p> : null}
    <PixelTabs value={route.tab} onChange={(tab) => changeRoute({ tab: tab as IntegrationTab })}>
      <PixelTabs.List ariaLabel="Integration sections" className="integration-tablist"><PixelTabs.Trigger value="overview">Overview</PixelTabs.Trigger><PixelTabs.Trigger value="metrics">Metrics</PixelTabs.Trigger><PixelTabs.Trigger value="configuration">Configuration</PixelTabs.Trigger></PixelTabs.List>
      <PixelTabs.Panel value="overview">{route.tab === "overview" ? metricsContent : null}</PixelTabs.Panel>
      <PixelTabs.Panel value="metrics">{route.tab === "metrics" ? metricsContent : null}</PixelTabs.Panel>
      <PixelTabs.Panel value="configuration">{route.tab === "configuration" ? <div className="integration-stack"><IntegrationConfiguration instance={instance} config={config} status={status} entry={entry} viewer={role === "VIEWER"} />{editable && os && catalogQuery.data ? <IntegrationConfigEditor key={`${organizationId}:${vmId}:${instanceId}:${role}:${os}`} organizationId={organizationId} vmId={vmId} instanceId={instanceId} role={role} os={os} initial={config} catalog={catalogQuery.data} onCancel={() => navigate(vmIntegrationsPath(vmId))} onSaved={(savedId) => { if (savedId === null) navigate(vmIntegrationsPath(vmId)); }} /> : <p className="integration-notice">Read-only configuration. Editing requires Admin or Operator access, a managed native Telegraf definition and a known catalog-supported operating system.</p>}{catalogQuery.isError ? <p role="alert" className="integration-notice">The catalog could not be refreshed. <PixelButton tone="neutral" size="sm" onClick={() => void catalogQuery.refetch()}>Retry catalog</PixelButton></p> : null}</div> : null}</PixelTabs.Panel>
    </PixelTabs>
    <details className="integration-card"><summary>Public technical details</summary><dl className="integration-definition-grid"><PublicValue label="Instance ID" value={instance.id} /><PublicValue label="Desired target" value={integrationTarget(instance)} /><div><dt>Metrics query time (not source time)</dt><dd>{integrationSampleTime(current?.queriedAt)}</dd></div><div><dt>Collector compatibility</dt><dd>{entry?.compatibility ?? "Not reported"}</dd></div></dl></details>
  </div>;
}
