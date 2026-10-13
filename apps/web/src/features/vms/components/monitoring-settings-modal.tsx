import { useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { PixelButton, PixelInput, PixelModal, PixelSelect } from "@pxlkit/ui-kit";
import { useQueryClient } from "@tanstack/react-query";
import { isApiError } from "../../../lib/api/api-error";
import { queryKeys } from "../../../lib/query/query-keys";
import { getVmMonitoringConfig, saveVmMonitoringConfig } from "../api/monitoring.api";
import { canManageAgent } from "../lib/agent-connect";
import { definitionFromDraft, draftFromDefinition, MAX_INTEGRATIONS, monitoringFieldId, newIntegration, validateMonitoringDraft } from "../lib/monitoring-draft";
import type { IntegrationKind, MonitoringCatalog, MonitoringConfigView, MonitoringFieldError, MonitoringSecretPatches, SupportedAgentOs } from "../monitoring.types";
import { IntegrationSettingsForm } from "./integration-settings-form";

interface Props {
  organizationId: string; vmId: string; role: string | undefined; os: SupportedAgentOs;
  initial: MonitoringConfigView; catalog: MonitoringCatalog; onClose: () => void;
}
// The parent keys this mounted session by organization/VM/role/OS, never version.
// Remote polling cannot overwrite a same-VM unsaved draft or silently rebase it.
export function MonitoringSettingsModal({ organizationId, vmId, role, os, initial, catalog, onClose }: Props) {
  const client = useQueryClient();
  const [snapshot, setSnapshot] = useState(initial);
  const [draft, setDraft] = useState(() => initial.definition ? draftFromDefinition(initial.definition) : null);
  const [secrets, setSecrets] = useState<MonitoringSecretPatches>({});
  const [kind, setKind] = useState<IntegrationKind>("redis");
  const [pending, setPending] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [errors, setErrors] = useState<MonitoringFieldError[]>([]);
  const summaryRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const lifetime = useRef({ active: true, busy: false, generation: 0, controller: undefined as AbortController | undefined });
  const allowed = canManageAgent(role);
  const blocked = pending || conflict || !allowed || !snapshot.managed || snapshot.version === null || !draft;
  const choices = catalog.integrations.filter((entry) => entry.supportedOs.includes(os));

  useLayoutEffect(() => {
    const session = lifetime.current; session.active = true;
    return () => { session.active = false; session.generation += 1; session.controller?.abort(); };
  }, []);
  useLayoutEffect(() => { if (errors.length || error) summaryRef.current?.focus(); }, [errors, error]);

  function close() {
    const session = lifetime.current; session.active = false; session.generation += 1; session.controller?.abort();
    setSecrets({}); setDraft(null); setErrors([]); setError(""); setNotice("");
    closeRef.current();
  }
  function changed() { setErrors([]); setError(""); setNotice(""); }
  function add() {
    if (blocked || !draft || lifetime.current.busy || draft.integrations.length >= MAX_INTEGRATIONS) return;
    if (!choices.some((entry) => entry.kind === kind)) return;
    setDraft({ ...draft, integrations: [...draft.integrations, newIntegration(kind, os, catalog.host.interval.default)] }); changed();
  }
  async function request(action: "save" | "reload") {
    const session = lifetime.current;
    if (!session.active || session.busy || !allowed || (action === "save" && blocked)) return;
    if (action === "save") {
      if (!draft || snapshot.version === null) return;
      const issues = validateMonitoringDraft(draft, secrets, snapshot, catalog, os);
      setErrors(issues); setError(""); setNotice("");
      if (issues.length) return;
    }
    session.busy = true;
    const generation = ++session.generation;
    const controller = new AbortController(); session.controller = controller;
    setPending(true); setError(""); setNotice("");
    // Explicit reload discards credentials immediately. Failed saves alone retain
    // the current scope's draft, allowing correction without accidental clears.
    if (action === "reload") { setSecrets({}); setErrors([]); }
    try {
      const result = action === "reload"
        ? await getVmMonitoringConfig(organizationId, vmId, controller.signal)
        : await saveVmMonitoringConfig(organizationId, vmId, {
          expectedVersion: snapshot.version!, definition: definitionFromDraft(draft!), secrets,
        }, controller.signal);
      if (!session.active || generation !== session.generation) return;
      await client.cancelQueries({ queryKey: queryKeys.vmMonitoringConfig(organizationId, vmId), exact: true });
      if (!session.active || generation !== session.generation) return;
      // Server canonical nonsecret response is the only post-save baseline.
      client.setQueryData(queryKeys.vmMonitoringConfig(organizationId, vmId), result);
      setSnapshot(result); setDraft(result.definition ? draftFromDefinition(result.definition) : null);
      setSecrets({}); setConflict(false); setErrors([]);
      setNotice(action === "reload" ? "Latest server definition loaded. Review it before saving; previous unsaved changes were discarded." : `Desired version ${result.version ?? "unknown"} saved; application is pending agent confirmation, not proof of running plugins or service health.`);
      // Only scoped nonsecret GET keys are invalidated; no mutation variables exist.
      if (action === "save") {
        void client.invalidateQueries({ queryKey: queryKeys.vmMonitoringConfig(organizationId, vmId), exact: true });
        void client.invalidateQueries({ queryKey: queryKeys.agentStatus(organizationId, vmId), exact: true });
      }
    } catch (failure) {
      if (!session.active || generation !== session.generation) return;
      if (isApiError(failure) && failure.statusCode === 409) {
        setConflict(true); setError("This definition changed on the server. Your draft was not saved. Reload and review the latest definition before editing again; no automatic overwrite, merge or retry is performed.");
      } else {
        const status = isApiError(failure) ? failure.statusCode : 0;
        setError(status === 403 ? "Access denied. Admin or Operator permission is required; the backend is authoritative." : status === 404 ? "The VM or native monitoring definition is no longer available." : status === 400 || status === 422 ? "The server rejected these settings. Review the service fields, TLS paths and explicit credential actions; no credential values are displayed in errors." : "The request could not be completed. Your current draft is retained. Reload to check the server version before retrying; a save may already have completed.");
      }
    } finally {
      if (session.active && generation === session.generation) { session.busy = false; session.controller = undefined; setPending(false); }
    }
  }
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); void request("save"); }

  return <PixelModal open title="Monitoring settings" description={`VM ${vmId} · ${os} · baseline desired version ${snapshot.version ?? "unavailable"}`} size="lg" onClose={close}>
    <form noValidate onSubmit={submit} className="max-h-[calc(100dvh-13rem)] min-w-0 space-y-4 overflow-y-auto" aria-busy={pending}>
      <p className="text-sm text-retro-muted">Native {catalog.host.profileKey} · Telegraf {catalog.host.compatibility}. Catalog contracts are source-derived; runtime collection remains {catalog.host.runtimeVerification}. This edits desired settings, not service health or metrics destinations.</p>
      {error || errors.length ? <div ref={summaryRef} tabIndex={-1} role="alert" className="space-y-2 border-2 border-retro-red p-3 text-sm text-retro-text focus-visible:outline-2 focus-visible:outline-retro-cyan">
        {error ? <p>{error}</p> : <p>Review these settings before saving:</p>}
        {errors.length ? <ul className="list-disc space-y-1 pl-5">{errors.map((issue, index) => <li key={`${issue.fieldId}:${index}`}><button type="button" className="text-left underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-retro-cyan" onClick={() => document.getElementById(issue.fieldId)?.focus()}>{issue.message}</button></li>)}</ul> : null}
      </div> : null}
      {notice ? <p role="status" aria-live="polite" className="border border-retro-cyan p-3 text-sm text-retro-text">{notice}</p> : null}
      {draft ? <>
        <fieldset className="space-y-3 border-2 border-retro-border p-4"><legend className="px-2 font-semibold text-retro-text">Host telemetry · {os} preset</legend>
          <PixelInput id={monitoringFieldId("host", "interval")} label="Host gather interval (seconds)" type="number" min={catalog.host.interval.minimum} max={catalog.host.interval.maximum} step={1} value={Number.isFinite(draft.host.intervalSeconds) ? draft.host.intervalSeconds : ""} disabled={blocked} error={errors.find((issue) => issue.fieldId === monitoringFieldId("host", "interval"))?.message} hint={`Default ${catalog.host.interval.default}s; ${catalog.host.interval.minimum}–${catalog.host.interval.maximum}s. CPU, memory, disk, network and ${os === "windows" ? "uptime; Windows load is unsupported" : "load/uptime"}.`} onChange={(event) => { if (lifetime.current.busy) return; setDraft({ ...draft, host: { intervalSeconds: event.target.valueAsNumber } }); changed(); }} />
          {draft.host.intervalSeconds > 300 ? <p className="text-sm text-retro-gold">Above the five-minute freshness/query window, host fields may be unknown and network rates unavailable between samples. Slower gathering also delays alert responsiveness.</p> : null}
        </fieldset>
        <p className="text-sm text-retro-muted">Instances {draft.integrations.length}/{MAX_INTEGRATIONS}. Edits and enable/disable preserve each UUID. To change a service kind, remove it and add a new instance (new UUID). Removal retires its credentials only after a successful server save.</p>
        {draft.integrations.map((instance) => {
          const entry = catalog.integrations.find((candidate) => candidate.kind === instance.kind);
          if (!entry) return <p key={instance.id} role="alert" className="text-sm text-retro-red">An instance is not in the supported catalog. Reload the server definition; saving is rejected.</p>;
          return <IntegrationSettingsForm key={instance.id} instance={instance} entry={entry} os={os} disabled={blocked} configured={snapshot.secretConfigured[instance.id] ?? {}} secrets={secrets[instance.id] ?? {}} errors={errors} onChange={(next) => { if (blocked || lifetime.current.busy) return; setDraft({ ...draft, integrations: draft.integrations.map((current) => current.id === next.id ? next : current) }); changed(); }} onSecretChange={(field, patch) => { if (blocked || lifetime.current.busy) return; setSecrets((current) => ({ ...current, [instance.id]: { ...current[instance.id], [field]: patch } })); changed(); }} onRemove={() => { if (blocked || lifetime.current.busy) return; setDraft({ ...draft, integrations: draft.integrations.filter((current) => current.id !== instance.id) }); setSecrets((current) => { const next = { ...current }; delete next[instance.id]; return next; }); changed(); }} />;
        })}
        <div className="grid items-end gap-3 sm:grid-cols-[1fr_auto]">
          <PixelSelect id={monitoringFieldId("add", "kind")} label="New integration kind" value={kind} options={choices.map((entry) => ({ value: entry.kind, label: entry.title }))} disabled={blocked || draft.integrations.length >= MAX_INTEGRATIONS} onChange={(value) => { const entry = choices.find((candidate) => candidate.kind === value); if (entry) setKind(entry.kind); }} />
          <PixelButton type="button" tone="neutral" disabled={blocked || draft.integrations.length >= MAX_INTEGRATIONS || !choices.length} onClick={add}>Add instance</PixelButton>
        </div>
      </> : <p className="text-sm text-retro-muted">No managed native definition is available. No empty/default definition will be saved.</p>}
      <div className="sticky bottom-0 flex flex-wrap gap-2 border-t border-retro-border bg-retro-surface py-3">
        <PixelButton type="submit" tone="cyan" disabled={blocked}>{pending ? "Request in progress…" : "Save desired settings"}</PixelButton>
        <PixelButton type="button" tone="neutral" variant="ghost" disabled={pending || !allowed} onClick={() => void request("reload")}>Reload latest / discard draft</PixelButton>
        <PixelButton type="button" tone="neutral" variant="ghost" onClick={close}>Close / discard unsaved</PixelButton>
      </div>
      <p className="text-xs text-retro-muted">Blank replacements never silently clear a credential. No passwords or OAuth client IDs are fetched, stored in query/mutation caches, copied, logged or persisted in browser storage.</p>
    </form>
  </PixelModal>;
}
