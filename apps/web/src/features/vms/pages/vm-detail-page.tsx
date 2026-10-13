import { useMemo, useReducer, useState, type FormEvent, type JSX } from "react";
import {
  PixelBadge,
  PixelButton,
  PixelEmptyState,
  PixelInput,
  PixelTabs,
} from "@pxlkit/ui-kit";
import { Link, useParams } from "react-router-dom";
import { useTenant } from "../../../app/providers/app-providers";
import { PxlKitIcon } from "../../../components/ui/pxlkit-icon";
import { isValidVmId, useVm, useVmCurrentMetrics, useVmMetricsRange, useVmTagMutation, type VmTagOperation } from "../hooks/use-vms";
import type { MetricName, Vm, VmChartMetric, VmMetricPoint, VmTimeRange } from "../vm.types";
import { isMetricSupported, unsupportedMetricReason } from "../lib/metric-capabilities";
import { metricSegments } from "../lib/metric-series";
import { EMPTY_TAG_DRAFT, tagDraftReducer } from "../lib/tag-draft";
import { isApiError } from "../../../lib/api/api-error";
import { createLocalDateTimeFormatter, getBrowserTimeZone } from "../../../lib/date-time";
import { VM_TIME_RANGES } from "../vm.types";
import { VmMetricCard } from "../components/vm-metric-card";
import { VmStatusBadge } from "../components/vm-status-badge";
import { ConnectVmModal } from "../components/connect-vm-modal";
import { VmMonitoringSection } from "../components/vm-monitoring-section";
import { canManageAgent } from "../lib/agent-connect";
import { VmFullTagList } from "../components/vm-tag-list";
import {
  formatLastSeen,
  formatLoad,
  formatMetric,
  formatUptime,
  tagToString,
  validateTagInput,
} from "../lib/vm-utils";

const chartSpecs: Array<{
  key: VmChartMetric;
  label: string;
  tone: "cyan" | "green" | "gold" | "red" | "purple" | "pink";
  suffix: string;
}> = [
  { key: "cpu", label: "CPU utilization", tone: "cyan", suffix: "%" },
  { key: "memory", label: "Memory utilization", tone: "green", suffix: "%" },
  { key: "disk", label: "Disk utilization", tone: "gold", suffix: "%" },
  { key: "networkRx", label: "Network RX", tone: "purple", suffix: " Mbps" },
  { key: "networkTx", label: "Network TX", tone: "pink", suffix: " Mbps" },
  { key: "load", label: "System load", tone: "red", suffix: "" },
];

const chartToneClasses = {
  cyan: "text-retro-cyan", green: "text-retro-green", gold: "text-retro-gold",
  red: "text-retro-red", purple: "text-retro-purple", pink: "text-retro-pink",
};

function MetricChart({ points, from, to, step, range, spec }: {
  points: VmMetricPoint[]; from: string; to: string; step: number;
  range: VmTimeRange; spec: (typeof chartSpecs)[number];
}) {
  const segments = metricSegments(points, from, to, step);
  const timeZone = getBrowserTimeZone();
  const timestampFormatter = createLocalDateTimeFormatter({ month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });
  const formatTimestamp = (timestamp: string) => timestampFormatter.format(new Date(timestamp));
  const values = segments.flatMap((segment) => segment.map((point) => point.value));
  const max = Math.max(1, ...values);
  const latest = points.at(-1)?.value;
  const latestLabel = latest == null || !Number.isFinite(latest) ? "—" : `${latest.toFixed(spec.key === "load" ? 2 : 1)}${spec.suffix}`;
  const x = (value: number) => 4 + value * 632;
  const y = (value: number) => 152 - (value / max) * 144;
  return (
    <figure className="border-2 border-retro-border bg-retro-surface p-4 shadow-[2px_2px_0_var(--cloudops-shadow)]" aria-label={`${spec.label} chart`}>
      <div className="flex items-start justify-between gap-3">
        <figcaption><h3 className="text-sm font-semibold text-retro-text">{spec.label}</h3><p className="mt-1 text-xs text-retro-muted">Last {range} · {timeZone}</p></figcaption>
        <span className="font-mono text-sm font-semibold text-retro-text">{latestLabel}</span>
      </div>
      <div className="mt-4 min-h-[10rem] border border-retro-border/70 bg-retro-canvas/30 p-2">
        {segments.length ? (
          <svg viewBox="0 0 640 160" preserveAspectRatio="none" className={`h-40 w-full ${chartToneClasses[spec.tone]}`} role="img" aria-label={`${spec.label} over ${range}; missing samples are gaps`}>
            <title>{`${spec.label} · ${formatTimestamp(from)} to ${formatTimestamp(to)} · ${timeZone}`}</title>
            {segments.map((segment, index) => {
              const coordinates = segment.map((point) => `${x(point.x)},${y(point.value)}`).join(" ");
              return segment.length === 1 ? <circle key={index} cx={x(segment[0].x)} cy={y(segment[0].value)} r="3" fill="currentColor" /> : (
                <g key={index}>
                  <polygon points={`${x(segment[0].x)},152 ${coordinates} ${x(segment.at(-1)!.x)},152`} fill="currentColor" fillOpacity="0.25" />
                  <polyline points={coordinates} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
                </g>
              );
            })}
          </svg>
        ) : <div className="flex min-h-[9rem] items-center justify-center text-center text-sm text-retro-muted" role="status">No telemetry samples in this time range.</div>}
      </div>
      <p className="mt-3 text-xs text-retro-muted">Latest sample: <span className="font-mono text-retro-text">{latestLabel}</span></p>
      <details className="mt-3 text-xs text-retro-muted">
        <summary className="cursor-pointer text-retro-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-retro-cyan">View {spec.label} samples</summary>
        <div className="mt-2 max-h-48 overflow-auto">
          <table className="w-full text-left" aria-label={`${spec.label} telemetry samples`}>
            <thead><tr><th scope="col">Timestamp ({timeZone})</th><th scope="col">Value{spec.suffix ? ` (${spec.suffix.trim()})` : ""}</th></tr></thead>
            <tbody>{points.map((point, index) => <tr key={`${point.timestamp}-${index}`}><td className="py-1 pr-3 font-mono"><time dateTime={point.timestamp}>{formatTimestamp(point.timestamp)}</time></td><td>{point.value == null || !Number.isFinite(point.value) ? "Missing" : `${point.value}${spec.suffix}`}</td></tr>)}</tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

function TagEditor({ vm, onCommit }: { vm: Vm; onCommit: (operation: VmTagOperation) => Promise<void> }) {
  const [draft, dispatch] = useReducer(tagDraftReducer, EMPTY_TAG_DRAFT);
  async function commit(operation: VmTagOperation, clearDraft: boolean) {
    if (draft.pending) return;
    dispatch({ type: "pending" });
    try {
      await onCommit(operation);
      if (clearDraft) dispatch({ type: "saved" });
      else dispatch({ type: "failed", error: "" });
    } catch (error) {
      dispatch({ type: "failed", error: isApiError(error) ? error.message : "Unable to save VM tags. Try again." });
    }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (draft.pending) return;
    const key = draft.key.trim(); const value = draft.value.trim();
    const error = validateTagInput(key, value);
    if (error) { dispatch({ type: "failed", error }); return; }
    if (key !== draft.editingKey && Object.prototype.hasOwnProperty.call(vm.tags, key)) {
      dispatch({ type: "failed", error: `The ${key} tag already exists.` }); return;
    }
    void commit(draft.tagId ? { action: "update", tagId: draft.tagId, input: { key, value } } : { action: "add", input: { key, value } }, true);
  }
  return (
    <div className="space-y-4" aria-busy={draft.pending}>
      <form className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end" onSubmit={submit} noValidate>
        <PixelInput label="Tag key" placeholder="site" value={draft.key} onChange={(event) => dispatch({ type: "key", value: event.target.value })} error={draft.error || undefined} disabled={draft.pending} />
        <PixelInput label="Tag value" placeholder="sea-01" value={draft.value} onChange={(event) => dispatch({ type: "value", value: event.target.value })} disabled={draft.pending} />
        <div className="flex gap-2">
          <PixelButton type="submit" tone="cyan" disabled={draft.pending}>{draft.pending ? "Saving…" : draft.tagId ? "Save tag" : "Add tag"}</PixelButton>
          {draft.tagId ? <PixelButton type="button" tone="neutral" variant="ghost" onClick={() => dispatch({ type: "reset" })} disabled={draft.pending}>Cancel</PixelButton> : null}
        </div>
      </form>
      {draft.error ? <p className="text-sm text-retro-red" role="alert">{draft.error}</p> : null}
      <div className="sr-only" role="status" aria-live="polite">{draft.pending ? "Saving VM tags" : ""}</div>
      {Object.keys(vm.tags).length ? (
        <ul className="grid gap-2 sm:grid-cols-2" aria-label="VM tags">
          {Object.entries(vm.tags).map(([key, value]) => {
            const tagId = vm.tagIds?.[key];
            return <li key={tagId ?? key} className="flex min-w-0 items-center justify-between gap-2 border border-retro-border/80 bg-retro-canvas/30 px-3 py-2">
              <PixelBadge tone="cyan" variant="soft" size="sm">{tagToString(key, value)}</PixelBadge>
              <span className="flex shrink-0 gap-1">
                <PixelButton type="button" tone="neutral" variant="ghost" size="sm" disabled={draft.pending || !tagId} onClick={() => tagId && dispatch({ type: "edit", key, value, tagId })} aria-label={`Edit ${tagToString(key, value)}`}><PxlKitIcon name="edit" size={14} /></PixelButton>
                <PixelButton type="button" tone="red" variant="ghost" size="sm" disabled={draft.pending || !tagId} onClick={() => tagId && void commit({ action: "delete", tagId }, draft.tagId === tagId)} aria-label={`Delete ${tagToString(key, value)}`}><PxlKitIcon name="trash" size={14} /></PixelButton>
              </span>
            </li>;
          })}
        </ul>
      ) : <p className="text-sm text-retro-muted">No tags yet. Add tags to organize and filter this VM.</p>}
    </div>
  );
}

export function VmDetailPage(): JSX.Element {
  const { vmId } = useParams<{ vmId: string }>();
  const { currentOrganization } = useTenant();
  return <VmDetailContent key={`${currentOrganization?.id ?? ""}:${vmId ?? ""}:${currentOrganization?.role ?? ""}`} />;
}

function VmDetailContent(): JSX.Element {
  const { vmId } = useParams<{ vmId: string }>();
  const { currentOrganization } = useTenant();
  const vmQuery = useVm(currentOrganization?.id ?? null, vmId ?? null);
  const [connectMode, setConnectMode] = useState<"reinstall" | "recover" | null>(null);
  const [range, setRange] = useState<VmTimeRange>("1h");
  const currentQuery = useVmCurrentMetrics(currentOrganization?.id ?? null, vmId ?? null);
  const rangeQuery = useVmMetricsRange(currentOrganization?.id ?? null, vmId ?? null, range);
  const tagMutation = useVmTagMutation(currentOrganization?.id ?? null, vmId ?? null);
  const vm = vmQuery.data;

  const rangeItems = useMemo(() => VM_TIME_RANGES.map((value) => ({
    id: value,
    label: value,
    content: null,
  })), []);

  if (!currentOrganization) return <PixelEmptyState title="No organization selected" description="Select an organization to view its virtual machines." />;
  if (!isValidVmId(vmId)) return <PixelEmptyState title="Invalid virtual machine link" description="Choose a VM from the inventory." action={<Link to="/vms">Back to VMs</Link>} />;

  if (vmQuery.isPending && !vm) {
    return <p className="text-sm text-retro-muted" role="status">Loading virtual machine…</p>;
  }

  if (vmQuery.isError && (!vm || vmQuery.error.statusCode === 403 || vmQuery.error.statusCode === 404)) {
    return (
      <PixelEmptyState
        title={vmQuery.error.statusCode === 403 ? "Access denied" : vmQuery.error.statusCode === 404 ? "Virtual machine not found" : "Unable to load virtual machine"}
        description={vmQuery.error.message}
        icon={<PxlKitIcon name="cloud" size={28} />}
        action={<Link to="/vms" className="inline-flex items-center border-2 border-retro-border bg-retro-cyan px-4 py-2 text-sm font-semibold text-retro-canvas shadow-[2px_2px_0_var(--cloudops-shadow)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-retro-cyan">Back to VMs</Link>}
      />
    );
  }

  if (!vm) {
    return (
      <PixelEmptyState
        title="Virtual machine not found"
        description="The VM may have been removed or the link may be out of date."
        icon={<PxlKitIcon name="cloud" size={28} />}
        action={<Link to="/vms" className="inline-flex items-center border-2 border-retro-border bg-retro-cyan px-4 py-2 text-sm font-semibold text-retro-canvas shadow-[2px_2px_0_var(--cloudops-shadow)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-retro-cyan">Back to VMs</Link>}
      />
    );
  }


  const metrics = currentQuery.isError ? null : currentQuery.data?.metrics;
  const telemetry = currentQuery.data ?? vm;
  // Never present the retained DB status as host health. An unavailable current read is neutral.
  const status = currentQuery.isError ? "unknown" : telemetry.hostState;
  // An explicit current null means no native metric timestamp, NOT the stored inventory timestamp.
  const lastSeenAt = currentQuery.data ? currentQuery.data.lastSeenAt : vm.lastSeenAt;
  const canManage = canManageAgent(currentOrganization.role);
  const currentCapabilities = currentQuery.isError || currentQuery.isPending
    ? undefined : currentQuery.data?.metricsCapabilities ?? vm.metricsCapabilities;
  const rangeCapabilities = rangeQuery.data?.metricsCapabilities ?? vm.metricsCapabilities;
  const currentReason = (name: MetricName) => unsupportedMetricReason(currentCapabilities, name);
  const currentValue = (name: MetricName, formatted: string) => isMetricSupported(currentCapabilities, name) ? formatted : "N/A";
  const lifecycleMessage = currentQuery.isError
    ? "Inventory retained. Current telemetry could not be read."
    : status === "unsupported"
      ? "Host state unsupported for this collector/platform. No legacy-to-native health inference is made."
      : status === "unknown"
        ? "Host state unknown. Agent API contact or fresh internal delivery alone does not prove host health."
        : status === "DISCONNECTED"
          ? `Inventory retained. No fresh native telemetry; last metric ${formatLastSeen(lastSeenAt)}.`
          : "Host state derived from authoritative native host telemetry.";

  return (
    <div className="space-y-6" data-testid="vm-detail-page">
      <Link to="/vms" className="inline-flex items-center gap-2 text-sm font-semibold text-retro-cyan underline underline-offset-4 hover:text-retro-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-retro-cyan">
        <PxlKitIcon name="arrow-left" size={14} /> Back to virtual machines
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-retro-cyan">VM detail</p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <h1 className="break-words text-3xl font-semibold tracking-tight text-retro-text">{vm.hostname}</h1>
            <VmStatusBadge status={status} />
          </div>
          <p className="mt-2 text-sm text-retro-muted">Created {formatLastSeen(vm.createdAt)} · Inventory record</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 text-xs text-retro-muted">
          <PixelBadge tone="neutral" variant="soft">Credential: {vm.agentStatus ?? "none"} (not delivery)</PixelBadge>
          <PixelButton type="button" tone="neutral" variant="ghost" disabled={!canManage} onClick={() => setConnectMode("reinstall")} title={!canManage ? "Admin or Operator role required" : "Reuse protected local identity; no new code"}>Reinstall locally</PixelButton>
          <PixelButton type="button" tone="cyan" disabled={!canManage} onClick={() => setConnectMode("recover")} title={!canManage ? "Admin or Operator role required" : "Explicit VM-bound recovery"}>Recover agent</PixelButton>
          <span className="border border-retro-border px-2 py-1">ID <span className="font-mono text-retro-text">{vm.id}</span></span>
        </div>
      </div>

      <div className={`border-2 p-4 ${status === "DISCONNECTED" ? "border-retro-gold bg-retro-gold/10" : "border-retro-border bg-retro-surface"}`} role={status === "DISCONNECTED" ? "alert" : "status"}>
        <div className="flex items-start gap-3">
          <VmStatusBadge status={status} />
          <p className="text-sm text-retro-text">{lifecycleMessage}</p>
        </div>
      </div>

      <section className="grid gap-4 border-2 border-retro-border bg-retro-surface p-4 shadow-[3px_3px_0_var(--cloudops-shadow)] sm:grid-cols-3" aria-labelledby="vm-identity-heading">
        <h2 id="vm-identity-heading" className="sr-only">VM identity</h2>
        <div><dt className="text-xs uppercase tracking-[0.08em] text-retro-muted">OS type</dt><dd className="mt-1 font-semibold text-retro-text">{vm.osType}</dd><p className="text-xs text-retro-muted">{vm.osVersion}</p></div>
        <div><dt className="text-xs uppercase tracking-[0.08em] text-retro-muted">IP address</dt><dd className="mt-1 font-mono font-semibold text-retro-text">{vm.ipAddress}</dd></div>
        <div><dt className="text-xs uppercase tracking-[0.08em] text-retro-muted">Last metric delivery</dt><dd className="mt-1 font-semibold text-retro-text">{formatLastSeen(lastSeenAt)}</dd><p className="text-xs text-retro-muted">{getBrowserTimeZone()}</p></div>
      </section>

      <section className="grid gap-3 border-2 border-retro-border bg-retro-surface p-4 text-sm sm:grid-cols-2" aria-labelledby="vm-telemetry-identity-heading">
        <h2 id="vm-telemetry-identity-heading" className="sr-only">Collector and delivery identity</h2>
        <p className="break-all text-retro-muted">Collector: <span className="text-retro-text">{telemetry.collectorType ?? "Unknown"} · {telemetry.collectorVersion ?? "version unknown"} · {telemetry.buildId ?? "build unknown"}</span></p>
        <p className="text-retro-muted">Compatibility: <span className="text-retro-text">{telemetry.telemetryCompatibility}</span> · Delivery: <span className="text-retro-text">{currentQuery.isError ? "unknown" : telemetry.telemetryDelivery}</span></p>
        <p className="text-retro-muted">Last agent API contact: <span className="text-retro-text">{formatLastSeen(telemetry.lastControlContactAt)}</span> · {getBrowserTimeZone()}</p>
        <p className="text-xs text-retro-muted">API contact, credential state and config ACK are not metric delivery or host health. Native-only history may have an Alloy cutover gap; Windows load remains unsupported.</p>
      </section>

      <VmMonitoringSection organizationId={currentOrganization.id} role={currentOrganization.role} vm={vm} />

      <section className="border-2 border-retro-border bg-retro-surface p-4 shadow-[3px_3px_0_var(--cloudops-shadow)]" aria-labelledby="vm-tags-heading">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div><h2 id="vm-tags-heading" className="text-lg font-semibold text-retro-text">Tags</h2><p className="mt-1 text-sm text-retro-muted">Use unique key:value tags to keep inventory filters consistent.</p></div>
          <VmFullTagList tags={vm.tags} />
        </div>
        <div className="mt-5 border-t border-retro-border/70 pt-5">{canManage ? <TagEditor key={`${currentOrganization.id}:${vm.id}`} vm={vm} onCommit={tagMutation.mutateAsync} /> : <p className="text-sm text-retro-muted">Read-only tags.</p>}</div>
      </section>

      <section aria-labelledby="vm-metrics-heading">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div><h2 id="vm-metrics-heading" className="text-lg font-semibold text-retro-text">Resource metrics</h2><p className="mt-1 text-sm text-retro-muted">Latest reported values · {getBrowserTimeZone()}{currentQuery.data?.sampledAt ? ` · Sampled ${formatLastSeen(currentQuery.data.sampledAt)}` : ""}</p></div>
          <PixelTabs items={rangeItems} value={range} onChange={(value) => setRange(value as VmTimeRange)} ariaLabel="Metric time range" />
        </div>
        {currentQuery.isError ? (
          <div className="mb-3 border border-retro-red p-3 text-sm text-retro-text" role="alert">
            <p>{currentQuery.error.code === "METRICS_DISABLED" ? "Metrics integration is disabled." : currentQuery.error.statusCode === 403 ? "Access denied to VM metrics." : currentQuery.error.statusCode === 404 ? "Virtual machine not found." : "Current metrics are unavailable."}</p>
            <PixelButton type="button" tone="neutral" variant="ghost" size="sm" onClick={() => void currentQuery.refetch()}>Retry current metrics</PixelButton>
          </div>
        ) : currentQuery.isPending ? <p className="mb-3 text-sm text-retro-muted" role="status">Loading current metrics…</p>
          : currentCapabilities?.platform === "unknown" ? <p className="mb-3 text-sm text-retro-muted" role="status">Unsupported platform</p>
          : currentQuery.data?.metricsState === "empty" ? <p className="mb-3 text-sm text-retro-muted" role="status">No fresh telemetry samples. Missing values are shown as dashes.</p> : null}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <VmMetricCard label="CPU" value={currentValue("cpu", formatMetric(metrics?.cpu))} detail={currentReason("cpu")} icon={<PxlKitIcon name="settings" size={14} />} />
          <VmMetricCard label="Memory" value={currentValue("memory", formatMetric(metrics?.memory))} detail={currentReason("memory")} icon={<PxlKitIcon name="cloud" size={14} />} />
          <VmMetricCard label="Disk" value={currentValue("disk", formatMetric(metrics?.disk))} detail={currentReason("disk")} icon={<PxlKitIcon name="organization" size={14} />} />
          <VmMetricCard label="Network RX" value={currentValue("networkRx", formatMetric(metrics?.networkRx, " Mbps"))} detail={currentReason("networkRx")} icon={<PxlKitIcon name="arrow-left" size={14} />} />
          <VmMetricCard label="Network TX" value={currentValue("networkTx", formatMetric(metrics?.networkTx, " Mbps"))} detail={currentReason("networkTx")} icon={<PxlKitIcon name="arrow-left" size={14} />} />
          <VmMetricCard label="Load" value={currentValue("load", formatLoad(metrics?.load))} detail={currentReason("load")} icon={<PxlKitIcon name="warning" size={14} />} />
          <VmMetricCard label="Uptime" value={currentValue("uptimeHours", formatUptime(metrics?.uptimeHours))} detail={currentReason("uptimeHours")} icon={<PxlKitIcon name="clock" size={14} />} />
        </div>
      </section>

      <section className="space-y-3" aria-labelledby="vm-charts-heading">
        <div><h2 id="vm-charts-heading" className="text-lg font-semibold text-retro-text">Telemetry charts</h2><p className="mt-1 text-sm text-retro-muted">Time range: <span className="font-mono text-retro-text">{range}</span>. Reported telemetry only; missing samples remain gaps.</p></div>
        {rangeQuery.isError ? (
          <div className="border border-retro-red p-3 text-sm text-retro-text" role="alert">
            <p>{rangeQuery.error.code === "METRICS_DISABLED" ? "Metrics integration is disabled." : rangeQuery.error.statusCode === 403 ? "Access denied to telemetry charts." : rangeQuery.error.statusCode === 404 ? "Virtual machine not found." : "Telemetry charts are unavailable."}</p>
            <PixelButton type="button" tone="neutral" variant="ghost" size="sm" onClick={() => void rangeQuery.refetch()}>Retry telemetry charts</PixelButton>
          </div>
        ) : rangeQuery.isPending ? <p className="text-sm text-retro-muted" role="status">Loading telemetry charts for {range}…</p>
          : rangeQuery.data ? <div className="grid gap-4 lg:grid-cols-2">
              {rangeCapabilities?.platform === "unknown" ? <p className="text-sm text-retro-muted" role="status">Unsupported platform</p> : null}
              {chartSpecs.filter((spec) => isMetricSupported(rangeCapabilities, spec.key)).map((spec) => <MetricChart key={spec.key} points={rangeQuery.data.series[spec.key]} from={rangeQuery.data.from} to={rangeQuery.data.to} step={rangeQuery.data.step} range={range} spec={spec} />)}
            </div> : null}
      </section>

      <ConnectVmModal
        open={connectMode !== null && canManage}
        organizationId={currentOrganization.id}
        role={currentOrganization.role}
        mode={connectMode ?? "reinstall"}
        vmId={vm.id}
        hostname={vm.hostname}
        agentActive={vm.agentStatus === "ACTIVE"}
        onClose={() => setConnectMode(null)}
      />
    </div>
  );
}
