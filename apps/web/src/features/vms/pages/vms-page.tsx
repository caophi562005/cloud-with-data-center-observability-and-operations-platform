import { useMemo, useState, type FormEvent, type JSX } from "react";
import {
  PixelBadge,
  PixelButton,
  PixelEmptyState,
  PixelInput,
  PixelModal,
  PixelMultiSelect,
  PixelSelect,
} from "@pxlkit/ui-kit";
import { Link } from "react-router-dom";
import { useTenant } from "../../../app/providers/app-providers";
import { PxlKitIcon } from "../../../components/ui/pxlkit-icon";
import { formatLocalDateTime, getBrowserTimeZone } from "../../../lib/date-time";
import { useCreateVm, useVms } from "../hooks/use-vms";
import type { Vm, VmGroupBy, VmStatus } from "../vm.types";
import { VM_STATUSES } from "../vm.types";
import { isMetricSupported } from "../lib/metric-capabilities";
import { VmStatusBadge } from "../components/vm-status-badge";
import { VmTagList } from "../components/vm-tag-list";
import {
  STATUS_LABELS,
  filterVms,
  formatMetric,
  formatUptime,
  groupVms,
  parseTagsInput,
  tagKeys,
  tagsToOptions,
} from "../lib/vm-utils";

const statusOptions = [
  { value: "ALL", label: "All statuses" },
  ...VM_STATUSES.map((status) => ({ value: status, label: STATUS_LABELS[status] })),
];

function inventoryCapabilities(vm: Vm) {
  return vm.metricsState === "disabled" || vm.metricsState === "unavailable" ? undefined : vm.metricsCapabilities;
}

function renderMetric(vm: Vm, name: "cpu" | "memory" | "disk" | "uptimeHours") {
  if (!isMetricSupported(inventoryCapabilities(vm), name)) return "N/A";
  return name === "uptimeHours" ? formatUptime(vm.metrics?.uptimeHours) : formatMetric(vm.metrics?.[name]);
}

function VmRows({ vms }: { vms: Vm[] }) {
  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[920px] border-collapse text-left" aria-label="Virtual machine inventory">
          <thead>
            <tr className="border-b-2 border-retro-border text-xs uppercase tracking-[0.08em] text-retro-muted">
              <th scope="col" className="px-4 py-3 font-semibold">Hostname</th>
              <th scope="col" className="px-4 py-3 font-semibold">OS Type</th>
              <th scope="col" className="px-4 py-3 font-semibold">Status</th>
              <th scope="col" className="px-4 py-3 font-semibold">CPU</th>
              <th scope="col" className="px-4 py-3 font-semibold">Memory</th>
              <th scope="col" className="px-4 py-3 font-semibold">Disk</th>
              <th scope="col" className="px-4 py-3 font-semibold">Uptime</th>
              <th scope="col" className="px-4 py-3 font-semibold">Tags</th>
            </tr>
          </thead>
          <tbody>
            {vms.map((vm) => (
              <tr key={vm.id} className="border-b border-retro-border/70 align-middle transition-colors hover:bg-retro-canvas/60">
                <td className="px-4 py-3">
                  <Link
                    to={`/vms/${vm.id}`}
                    className="font-semibold text-retro-cyan underline decoration-transparent underline-offset-4 transition hover:decoration-current focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-retro-cyan"
                  >
                    {vm.hostname}
                  </Link>
                  <span className="mt-1 block text-xs text-retro-muted">{vm.ipAddress}</span>
                  {inventoryCapabilities(vm)?.platform === "unknown" ? <span className="mt-1 block text-xs text-retro-muted">Unsupported platform</span> : null}
                </td>
                <td className="px-4 py-3 text-sm text-retro-text">{vm.osType}</td>
                <td className="px-4 py-3"><VmStatusBadge status={vm.status} /></td>
                <td className="px-4 py-3 font-mono text-sm text-retro-text">{renderMetric(vm, "cpu")}</td>
                <td className="px-4 py-3 font-mono text-sm text-retro-text">{renderMetric(vm, "memory")}</td>
                <td className="px-4 py-3 font-mono text-sm text-retro-text">{renderMetric(vm, "disk")}</td>
                <td className="px-4 py-3 font-mono text-sm text-retro-text">{renderMetric(vm, "uptimeHours")}</td>
                <td className="max-w-[240px] px-4 py-3"><VmTagList tags={vm.tags} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid gap-3 md:hidden">
        {vms.map((vm) => (
          <article key={vm.id} className="border-2 border-retro-border bg-retro-surface p-4 shadow-[2px_2px_0_var(--cloudops-shadow)]">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <Link
                  to={`/vms/${vm.id}`}
                  className="break-words font-semibold text-retro-cyan underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-retro-cyan"
                >
                  {vm.hostname}
                </Link>
                <p className="mt-1 text-xs text-retro-muted">{vm.osType} · {vm.ipAddress}</p>
                {inventoryCapabilities(vm)?.platform === "unknown" ? <p className="mt-1 text-xs text-retro-muted">Unsupported platform</p> : null}
              </div>
              <VmStatusBadge status={vm.status} />
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              <div><dt className="text-xs text-retro-muted">CPU</dt><dd className="font-mono text-retro-text">{renderMetric(vm, "cpu")}</dd></div>
              <div><dt className="text-xs text-retro-muted">Memory</dt><dd className="font-mono text-retro-text">{renderMetric(vm, "memory")}</dd></div>
              <div><dt className="text-xs text-retro-muted">Disk</dt><dd className="font-mono text-retro-text">{renderMetric(vm, "disk")}</dd></div>
              <div><dt className="text-xs text-retro-muted">Uptime</dt><dd className="font-mono text-retro-text">{renderMetric(vm, "uptimeHours")}</dd></div>
            </dl>
            <div className="mt-4 border-t border-retro-border/70 pt-3"><VmTagList tags={vm.tags} /></div>
          </article>
        ))}
      </div>
    </>
  );
}

function AddVmModal({
  open,
  organizationId,
  onClose,
}: {
  open: boolean;
  organizationId: string | null;
  onClose: () => void;
}) {
  const [hostname, setHostname] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [error, setError] = useState<string>();
  const createVmMutation = useCreateVm(organizationId);
  const result = createVmMutation.data;

  function reset() {
    setHostname("");
    setTagsInput("");
    setError(undefined);
    createVmMutation.reset();
  }

  function handleClose() {
    reset();
    onClose();
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedHostname = hostname.trim();
    if (!organizationId) {
      setError("Select an organization before creating a VM.");
      return;
    }
    if (!normalizedHostname) {
      setError("Hostname is required.");
      return;
    }
    const parsedTags = parseTagsInput(tagsInput);
    if (parsedTags.error) {
      setError(parsedTags.error);
      return;
    }
    setError(undefined);
    createVmMutation.mutate(
      { hostname: normalizedHostname, tags: parsedTags.tags },
    );
  }

  return (
    <PixelModal
      open={open}
      onClose={handleClose}
      title="Add virtual machine"
      description="Create the VM inventory record and issue a one-time agent enrollment token."
      size="md"
      footer={(
        <div className="flex justify-end gap-2">
          {result ? (
            <PixelButton type="button" tone="cyan" onClick={handleClose}>Done</PixelButton>
          ) : (
            <>
              <PixelButton type="button" tone="neutral" variant="ghost" onClick={handleClose}>Cancel</PixelButton>
              <PixelButton type="submit" form="add-vm-form" tone="cyan" disabled={createVmMutation.isPending}>
                {createVmMutation.isPending ? "Creating…" : "Add VM"}
              </PixelButton>
            </>
          )}
        </div>
      )}
    >
      {result ? (
        <div className="space-y-4" role="status" aria-live="polite">
          <div className="border-2 border-retro-green bg-retro-green/10 p-3">
            <p className="text-sm font-semibold text-retro-text">VM created: {result.vm.hostname}</p>
            <p className="mt-1 text-xs text-retro-muted">Copy this token now. It is returned only during VM creation.</p>
          </div>
          <div className="border-2 border-retro-border bg-retro-canvas/40 p-3">
            <p className="text-xs uppercase tracking-[0.08em] text-retro-muted">Enrollment token</p>
            <code className="mt-2 block break-all font-mono text-sm text-retro-text">{result.enrollment.token}</code>
            <p className="mt-2 text-xs text-retro-muted">Expires {formatLocalDateTime(result.enrollment.expiresAt, { dateStyle: "medium", timeStyle: "short" })} · {getBrowserTimeZone()}</p>
          </div>
          {result.failedTags.length > 0 ? (
            <p className="text-sm text-retro-gold" role="alert">
              VM was created, but these tags could not be saved: {result.failedTags.join(", ")}.
            </p>
          ) : null}
        </div>
      ) : (
        <form id="add-vm-form" className="grid gap-4" onSubmit={handleSubmit} noValidate>
          <PixelInput
            label="Hostname"
            placeholder="e.g. web-prod-04"
            value={hostname}
            onChange={(event) => setHostname(event.target.value)}
            error={error && !hostname.trim() ? error : undefined}
            required
            autoFocus
          />
          <PixelInput
            label="Tags (optional)"
            hint="Separate tags with commas, for example site:sea-01, role:api"
            placeholder="site:sea-01, role:api"
            value={tagsInput}
            onChange={(event) => setTagsInput(event.target.value)}
            error={error && hostname.trim() ? error : undefined}
          />
          {createVmMutation.isError ? (
            <p className="text-sm text-retro-red" role="alert">{createVmMutation.error.message}</p>
          ) : null}
          <div className="border-2 border-dashed border-retro-border p-3">
            <p className="text-sm font-semibold text-retro-text">Agent enrollment</p>
            <p className="mt-1 text-xs text-retro-muted">The token above is used by the Linux or Windows release launcher.</p>
          </div>
        </form>
      )}
    </PixelModal>
  );
}

export function VmsPage(): JSX.Element {
  const { currentOrganization } = useTenant();
  const vmsQuery = useVms(currentOrganization?.id ?? null);
  const vms = useMemo(() => vmsQuery.data ?? [], [vmsQuery.data]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<VmStatus | "ALL">("ALL");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [groupBy, setGroupBy] = useState<VmGroupBy>("none");
  const [isAddOpen, setIsAddOpen] = useState(false);

  const filteredVms = useMemo(() => filterVms(vms, { query, status, tags: selectedTags }), [vms, query, status, selectedTags]);
  const groups = useMemo(() => groupVms(filteredVms, groupBy), [filteredVms, groupBy]);
  const tagOptions = useMemo(() => tagsToOptions(vms).map((tag) => ({ value: tag, label: tag })), [vms]);
  const groupOptions = useMemo(() => [
    { value: "none", label: "None" },
    { value: "os", label: "OS Type" },
    { value: "status", label: "Status" },
    ...tagKeys(vms).map((key) => ({ value: `tag:${key}`, label: `Tag: ${key}` })),
    { value: "untagged", label: "Untagged" },
  ], [vms]);

  const statusCounts = useMemo(() => VM_STATUSES.reduce<Record<string, number>>((counts, value) => {
    counts[value] = vms.filter((vm) => vm.status === value).length;
    return counts;
  }, {}), [vms]);

  function clearFilters() {
    setQuery("");
    setStatus("ALL");
    setSelectedTags([]);
  }

  const hasFilters = Boolean(query.trim()) || status !== "ALL" || selectedTags.length > 0;
  const isLoadingVms = Boolean(currentOrganization) && vmsQuery.isPending;
  const hasVmsError = Boolean(currentOrganization) && vmsQuery.isError;

  return (
    <div className="space-y-6" data-testid="vms-page">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-retro-cyan">Infrastructure</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-retro-text">Virtual machines</h1>
          <p className="mt-2 max-w-2xl text-sm text-retro-muted">Monitor host health, resource pressure, and agent connectivity across your inventory.</p>
        </div>
        <PixelButton type="button" tone="cyan" onClick={() => setIsAddOpen(true)} disabled={!currentOrganization}>
          <span className="mr-2" aria-hidden="true">+</span>Add VM
        </PixelButton>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Virtual machine status summary">
        {VM_STATUSES.map((vmStatus) => (
          <button
            type="button"
            key={vmStatus}
            onClick={() => setStatus(vmStatus)}
            className="border-2 border-retro-border bg-retro-surface p-3 text-left shadow-[2px_2px_0_var(--cloudops-shadow)] transition hover:-translate-y-px focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-retro-cyan"
            aria-label={`Filter by ${STATUS_LABELS[vmStatus]}`}
          >
            <span className="block text-xs uppercase tracking-[0.08em] text-retro-muted">{STATUS_LABELS[vmStatus]}</span>
            <span className="mt-1 block font-mono text-2xl font-semibold text-retro-text">{statusCounts[vmStatus] ?? 0}</span>
          </button>
        ))}
      </div>

      <section className="border-2 border-retro-border bg-retro-surface p-4 shadow-[3px_3px_0_var(--cloudops-shadow)]" aria-label="Virtual machine filters">
        <div className="grid gap-3 lg:grid-cols-[minmax(16rem,1.4fr)_minmax(10rem,0.7fr)_minmax(13rem,1fr)_minmax(10rem,0.7fr)]">
          <PixelInput
            label="Search hostnames"
            placeholder="Search by hostname"
            icon={<PxlKitIcon name="search" size={14} />}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            clearable
            onClear={() => setQuery("")}
          />
          <PixelSelect label="Status" options={statusOptions} value={status} onChange={(value) => setStatus(value as VmStatus | "ALL")} />
          <PixelMultiSelect label="Tags (all must match)" placeholder="Filter by tags" options={tagOptions} value={selectedTags} onChange={setSelectedTags} searchable clearable />
          <PixelSelect label="Group by" options={groupOptions} value={groupBy} onChange={(value) => setGroupBy(value as VmGroupBy)} />
        </div>
        {hasFilters ? (
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-retro-border/70 pt-3">
            <span className="text-xs font-semibold uppercase tracking-[0.08em] text-retro-muted">Active filters</span>
            {query.trim() ? <button type="button" className="rounded-sm border border-retro-border px-2 py-1 text-xs text-retro-text hover:border-retro-cyan" onClick={() => setQuery("")}>Hostname: {query.trim()} ×</button> : null}
            {status !== "ALL" ? <button type="button" className="rounded-sm border border-retro-border px-2 py-1 text-xs text-retro-text hover:border-retro-cyan" onClick={() => setStatus("ALL")}>Status: {STATUS_LABELS[status]} ×</button> : null}
            {selectedTags.map((tag) => <button type="button" key={tag} className="rounded-sm border border-retro-border px-2 py-1 text-xs text-retro-text hover:border-retro-cyan" onClick={() => setSelectedTags((current) => current.filter((item) => item !== tag))}>Tag: {tag} ×</button>)}
            <PixelButton type="button" tone="neutral" variant="ghost" size="sm" onClick={clearFilters}>Clear all</PixelButton>
          </div>
        ) : null}
      </section>

      {isLoadingVms ? (
        <div className="border-2 border-retro-border bg-retro-surface p-8 text-center" role="status" aria-live="polite">
          <p className="text-sm text-retro-muted">Loading virtual machine inventory…</p>
        </div>
      ) : hasVmsError ? (
        <PixelEmptyState
          title="Unable to load virtual machines"
          description={vmsQuery.error?.message ?? "The VM inventory could not be loaded. Try again."}
          icon={<PxlKitIcon name="error" size={28} />}
          action={<PixelButton type="button" tone="cyan" onClick={() => void vmsQuery.refetch()}>Try again</PixelButton>}
        />
      ) : !currentOrganization ? (
        <PixelEmptyState
          title="No organization selected"
          description="Select an organization to load its virtual machine inventory."
          icon={<PxlKitIcon name="organization" size={28} />}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-retro-muted">
            <div className="flex items-center gap-2">
              <p aria-live="polite"><span className="font-semibold text-retro-text">{filteredVms.length}</span> of {vms.length} virtual machines</p>
              <PixelButton
                type="button"
                tone="cyan"
                variant="ghost"
                size="sm"
                className="h-9 shrink-0"
                aria-label="Refresh virtual machines"
                title="Refresh virtual machines"
                aria-busy={vmsQuery.isFetching}
                disabled={!currentOrganization || vmsQuery.isFetching}
                onClick={() => void vmsQuery.refetch({ cancelRefetch: false })}
              >
                Refresh
              </PixelButton>
              <span className="sr-only" role="status">{vmsQuery.isFetching ? "Refreshing virtual machine inventory…" : ""}</span>
            </div>
            {groupBy !== "none" ? <p>Grouped by <span className="font-semibold text-retro-text">{groupOptions.find((option) => option.value === groupBy)?.label ?? groupBy}</span></p> : null}
          </div>

          {vms.some((vm) => vm.metricsState === "disabled") ? (
            <div className="border-2 border-retro-border bg-retro-surface p-4 text-sm text-retro-muted" role="status">
              Metrics integration is disabled. Inventory remains available; telemetry values are unavailable.
            </div>
          ) : null}
          {vms.some((vm) => vm.metricsState === "unavailable") ? (
            <div className="border-2 border-retro-border bg-retro-surface p-4 text-sm text-retro-muted" role="alert">
              Metrics are unavailable. Inventory remains available; use Refresh to retry telemetry.
            </div>
          ) : null}
          {filteredVms.length === 0 ? (
            <PixelEmptyState
              title={vms.length === 0 ? "No virtual machines yet" : "No matching virtual machines"}
              description={vms.length === 0 ? "Add a VM to start building your inventory." : "Try a different hostname, status, or tag combination."}
              icon={<PxlKitIcon name="cloud" size={28} />}
              action={vms.length === 0 ? <PixelButton type="button" tone="cyan" onClick={() => setIsAddOpen(true)}>Add VM</PixelButton> : <PixelButton type="button" tone="neutral" variant="soft" onClick={clearFilters}>Clear filters</PixelButton>}
            />
          ) : (
            <div className="space-y-5">
              {groups.map((group) => (
                <section key={group.label} aria-labelledby={`vm-group-${group.label}`} className="border-2 border-retro-border bg-retro-surface shadow-[3px_3px_0_var(--cloudops-shadow)]">
                  {groupBy !== "none" ? (
                    <div className="flex items-center justify-between border-b-2 border-retro-border px-4 py-3">
                      <h2 id={`vm-group-${group.label}`} className="text-sm font-semibold text-retro-text">{group.label}</h2>
                      <PixelBadge tone="neutral" variant="soft" size="sm">{group.vms.length}</PixelBadge>
                    </div>
                  ) : null}
                  <VmRows vms={group.vms} />
                </section>
              ))}
            </div>
          )}
        </>
      )}

      <AddVmModal
        open={isAddOpen}
        organizationId={currentOrganization?.id ?? null}
        onClose={() => setIsAddOpen(false)}
      />
    </div>
  );
}
