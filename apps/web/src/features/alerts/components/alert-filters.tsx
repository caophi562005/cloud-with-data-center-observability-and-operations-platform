import { useEffect, useState, type JSX } from "react";
import { PixelButton, PixelInput, PixelSelect } from "@pxlkit/ui-kit";
import { useTenant } from "../../../app/providers/app-providers";
import { useVms } from "../../vms/hooks/use-vms";
import type { AlertListState } from "../alert.types";
export function AlertFilters({ state, onChange }: { state: AlertListState; onChange(patch: Partial<AlertListState>): void }): JSX.Element {
  const tenant = useTenant(); const [resourceOpen, setResourceOpen] = useState(false);
  const vms = useVms(resourceOpen ? tenant.currentOrganization?.id ?? null : null);
  const resourceOptions = [{ value: "all", label: "All resources" }, ...(vms.data ?? []).map((vm) => ({ value: vm.id, label: vm.hostname }))];
  if (state.vmId && !resourceOptions.some((option) => option.value === state.vmId)) resourceOptions.push({ value: state.vmId, label: state.vmId });
  const [draft, setDraft] = useState({ base: state.q, value: state.q });
  if (draft.base !== state.q) setDraft({ base: state.q, value: state.q });
  const search = draft.base === state.q ? draft.value : state.q;
  useEffect(() => { if (search.trim() === state.q) return; const timer = setTimeout(() => onChange({ q: search.trim().slice(0, 120) }), 300); return () => clearTimeout(timer); }, [search, state.q, onChange]);
  return <div className="grid grid-cols-[minmax(12rem,2fr)_repeat(3,minmax(8rem,1fr))] items-end gap-3 max-[901px]:grid-cols-2 max-[640px]:grid-cols-1">
    <div><PixelInput id="alert-search" label="Search alerts or resources" value={search} maxLength={120} onChange={(event) => setDraft({ base: state.q, value: event.target.value })} aria-describedby="alert-search-hint" placeholder="Alert name or VM hostname" /><p id="alert-search-hint" className="mt-1 text-xs text-retro-muted">Searches all pages, not just visible rows.</p></div>
    <PixelSelect id="alert-severity" label="Severity" value={state.severity ?? "all"} options={[{ value: "all", label: "All severities" }, { value: "CRITICAL", label: "Critical" }, { value: "WARNING", label: "Warning" }]} onChange={(value) => onChange({ severity: value === "all" ? undefined : value as AlertListState["severity"] })} />
    <PixelSelect id="alert-workflow" label="Workflow" value={state.workflowStatus ?? "all"} options={[{ value: "all", label: "All workflows" }, { value: "OPEN", label: "Open" }, { value: "ACKNOWLEDGED", label: "Acknowledged" }]} onChange={(value) => onChange({ workflowStatus: value === "all" ? undefined : value as AlertListState["workflowStatus"] })} />
    <PixelSelect id="alert-sort" label="Sort" value={state.sort} options={[{ value: "severity_desc", label: "Critical first, newest" }, { value: "started_at_desc", label: "Newest source time" }, { value: "started_at_asc", label: "Oldest source time" }]} onChange={(value) => onChange({ sort: value as AlertListState["sort"] })} />
    <div className="col-span-full"><PixelButton type="button" variant="ghost" aria-expanded={resourceOpen} aria-controls="alert-resource-filter" onClick={() => setResourceOpen(!resourceOpen)}>Filter resource{state.vmId ? " · active" : ""}</PixelButton>{state.vmId ? <PixelButton type="button" variant="ghost" onClick={() => onChange({ vmId: undefined })}>Clear resource</PixelButton> : null}
      {resourceOpen ? <div id="alert-resource-filter" className="mt-3 max-w-sm"><PixelSelect id="alert-resource" label="Resource" value={state.vmId ?? "all"} options={resourceOptions} onChange={(value) => onChange({ vmId: value === "all" ? undefined : value })} disabled={vms.isPending} />{vms.isPending ? <p role="status">Loading resources…</p> : null}{vms.isError ? <p role="alert">Resource options unavailable. Search by hostname instead.</p> : null}</div> : null}
    </div>
  </div>;
}
