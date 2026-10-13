import { useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { PixelButton, PixelSelect } from "@pxlkit/ui-kit";
import { useQueryClient } from "@tanstack/react-query";
import { isApiError } from "../../../lib/api/api-error";
import { queryKeys } from "../../../lib/query/query-keys";
import { getVmMonitoringConfig, saveVmMonitoringConfig } from "../api/monitoring.api";
import { canManageAgent } from "../lib/agent-connect";
import { buildIntegrationSaveInput } from "../lib/integration-config-draft";
import { MAX_INTEGRATIONS, monitoringFieldId, newIntegration, validateMonitoringDraft } from "../lib/monitoring-draft";
import type { IntegrationDraft, MonitoringCatalog, MonitoringConfigView, MonitoringFieldError, MonitoringSecretPatches, SupportedAgentOs } from "../monitoring.types";
import { IntegrationSettingsForm } from "./integration-settings-form";

interface Props {
  organizationId: string; vmId: string; instanceId?: string; role: string; os: SupportedAgentOs;
  initial: MonitoringConfigView; catalog: MonitoringCatalog;
  onCancel: () => void; onSaved: (instanceId: string | null) => void;
}
/** Parent mounts only on the active Configuration tab, keyed by org/VM/instance/role/OS, never version. */
export function IntegrationConfigEditor({ organizationId, vmId, instanceId, role, os, initial, catalog, onCancel, onSaved }: Props) {
  const client = useQueryClient();
  const choices = catalog.integrations.filter((entry) => entry.supportedOs.includes(os));
  const [snapshot, setSnapshot] = useState(() => structuredClone(initial));
  const [draft, setDraft] = useState<IntegrationDraft | null>(() => instanceId
    ? structuredClone(initial.definition?.integrations.find((item) => item.id === instanceId) ?? null)
    : choices[0] ? newIntegration(choices[0].kind, os, catalog.host.interval.default) : null);
  const [secrets, setSecrets] = useState<MonitoringSecretPatches>({});
  const [pending, setPending] = useState(false); const [conflict, setConflict] = useState(false);
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const [errors, setErrors] = useState<MonitoringFieldError[]>([]);
  const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const summary = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onCancel, onSaved });
  useLayoutEffect(() => { callbacks.current = { onCancel, onSaved }; }, [onCancel, onSaved]);
  const lifetime = useRef({ active: true, busy: false, generation: 0, controller: undefined as AbortController | undefined });
  const allowed = canManageAgent(role) && snapshot.managed && snapshot.version !== null && Boolean(snapshot.definition) && catalog.host.supportedOs.includes(os);
  const blocked = !allowed || pending || conflict || !draft || (!instanceId && (snapshot.definition?.integrations.length ?? 0) >= MAX_INTEGRATIONS);
  const entry = catalog.integrations.find((item) => item.kind === draft?.kind && item.supportedOs.includes(os));
  useLayoutEffect(() => {
    const session = lifetime.current; session.active = true;
    return () => { session.active = false; session.generation++; session.controller?.abort(); };
  }, []);
  useLayoutEffect(() => { if (error || errors.length) summary.current?.focus(); }, [error, errors]);
  function changed() { setErrors([]); setError(""); setNotice(""); }
  function cancel() {
    const session = lifetime.current; session.active = false; session.generation++; session.controller?.abort();
    setSecrets({}); setDraft(null); callbacks.current.onCancel();
  }
  async function request(action: "save" | "reload" | "remove") {
    const session = lifetime.current;
    if (!session.active || session.busy || !allowed || (action !== "reload" && blocked)) return;
    const selectedId = instanceId ?? draft?.id;
    if (!selectedId || (action === "remove" && (!instanceId || !confirmRemoval))) return;
    if (action === "save") {
      if (!draft || !entry || !snapshot.definition) return;
      if (instanceId && !snapshot.definition.integrations.some((item) => item.id === instanceId)) { setError("The selected instance no longer exists. Reload and review the definition."); return; }
      const issues = validateMonitoringDraft({ ...snapshot.definition, integrations: [draft] }, secrets, snapshot, catalog, os).filter((issue) => issue.fieldId !== monitoringFieldId("host", "interval"));
      setErrors(issues); setError(""); setNotice(""); if (issues.length) return;
    }
    session.busy = true; const generation = ++session.generation;
    const controller = new AbortController(); session.controller = controller; setPending(true); setError(""); setNotice("");
    if (action === "reload") { setSecrets({}); setErrors([]); }
    try {
      // Direct typed PATCH only: secret-bearing input never enters Query/MutationCache.
      const result = action === "reload" ? await getVmMonitoringConfig(organizationId, vmId, controller.signal)
        : await saveVmMonitoringConfig(organizationId, vmId, buildIntegrationSaveInput(snapshot, selectedId, action === "remove" ? null : draft, action === "remove" ? {} : secrets), controller.signal);
      if (!session.active || generation !== session.generation) return;
      await client.cancelQueries({ queryKey: queryKeys.vmMonitoringConfig(organizationId, vmId), exact: true });
      if (!session.active || generation !== session.generation) return;
      client.setQueryData(queryKeys.vmMonitoringConfig(organizationId, vmId), result);
      setSnapshot(structuredClone(result)); setSecrets({}); setErrors([]); setConflict(false); setConfirmRemoval(false);
      const saved = result.definition?.integrations.find((item) => item.id === selectedId);
      if (action === "reload") {
        setDraft(instanceId ? structuredClone(result.definition?.integrations.find((item) => item.id === instanceId) ?? null) : draft ? newIntegration(draft.kind, os, catalog.host.interval.default) : null);
        setNotice("Latest definition loaded. Unsaved changes and replacements were discarded; review before saving.");
      } else {
        setDraft(saved ? structuredClone(saved) : null);
        setNotice(`Desired version ${result.version ?? "unknown"} saved. Agent application is pending confirmation, not proof of service health or a new target sample.`);
        void client.invalidateQueries({ queryKey: queryKeys.vmMonitoringConfig(organizationId, vmId), exact: true });
        void client.invalidateQueries({ queryKey: queryKeys.agentStatus(organizationId, vmId), exact: true });
        void client.invalidateQueries({ queryKey: queryKeys.integrationMetrics(organizationId, vmId, selectedId) });
        if (action === "remove") callbacks.current.onSaved(null);
        else if (saved) callbacks.current.onSaved(saved.id);
        else setError("The saved response did not contain the selected instance. Reload and review before proceeding.");
      }
    } catch (failure) {
      if (!session.active || generation !== session.generation) return;
      const status = isApiError(failure) ? failure.statusCode : 0;
      if (status === 409) { setConflict(true); setError("The server definition changed. This draft was not saved. Reload / review explicitly to discard it and clear replacements; no automatic merge or version retry occurs."); }
      else setError(status === 403 ? "Access denied. Admin or Operator permission is required; the server is authoritative." : status === 404 ? "The VM or monitoring definition is no longer available." : status === 400 || status === 422 ? "The server rejected these settings. Review the typed fields and explicit credential actions. Credential values and server diagnostics are never displayed." : "The request could not be completed. Your draft is retained. Reload to review the server version before retrying; a save may already have completed.");
    } finally { if (session.active && generation === session.generation) { session.busy = false; session.controller = undefined; setPending(false); } }
  }
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (!confirmRemoval) void request("save"); }
  if (!allowed) return <p className="integration-notice">Read-only configuration. A managed native definition, known supported OS and Admin or Operator permission are required.</p>;
  return <form noValidate onSubmit={submit} aria-busy={pending} className="integration-stack">
    <h2>{instanceId ? "Edit configuration" : "Add integration"}</h2>
    <p className="integration-muted">Captured desired version {snapshot.version ?? "unavailable"} · {os}. Only this integration changes; host settings and every other instance are preserved.</p>
    {error || errors.length ? <div ref={summary} tabIndex={-1} role="alert" className="integration-card integration-error"><p>{error || "Review these fields before saving:"}</p>{errors.length ? <ul>{errors.map((issue, index) => <li key={`${issue.fieldId}:${index}`}><button type="button" className="text-left underline focus-visible:outline-2 focus-visible:outline-retro-cyan" onClick={() => document.getElementById(issue.fieldId)?.focus()}>{issue.message}</button></li>)}</ul> : null}</div> : null}
    {notice ? <p role="status" aria-live="polite" className="integration-notice">{notice}</p> : null}
    {!instanceId && draft ? <PixelSelect id={monitoringFieldId("add", "kind")} label="Integration kind" value={draft.kind} disabled={blocked} options={choices.map((item) => ({ value: item.kind, label: item.title }))} onChange={(value) => { if (blocked || lifetime.current.busy) return; const next = choices.find((item) => item.kind === value); if (next && next.kind !== draft.kind) { setSecrets({}); setDraft(newIntegration(next.kind, os, catalog.host.interval.default)); changed(); } }} /> : null}
    {draft && entry ? <IntegrationSettingsForm key={draft.id} instance={draft} entry={entry} os={os} disabled={blocked || confirmRemoval} configured={snapshot.secretConfigured[draft.id] ?? {}} secrets={secrets[draft.id] ?? {}} errors={errors} onChange={(next) => { if (blocked || lifetime.current.busy) return; setDraft(next); changed(); }} onSecretChange={(field, patch) => { if (blocked || lifetime.current.busy) return; setSecrets((current) => ({ ...current, [draft.id]: { ...current[draft.id], [field]: patch } })); changed(); }} /> : <p role="status">No selected supported integration is available. Reload / review the latest definition.</p>}
    {!instanceId && (snapshot.definition?.integrations.length ?? 0) >= MAX_INTEGRATIONS ? <p role="status">The VM already has 16 integrations. No additional instance can be saved.</p> : null}
    {confirmRemoval ? <section className="integration-card" aria-labelledby="integration-remove-heading"><h3 id="integration-remove-heading">Remove this integration definition?</h3><p>Only this instance and its stored credentials will be retired after a successful save. This does not delete a VM, service, container, resource or file. Host telemetry and other integrations remain unchanged.</p><div className="flex flex-wrap gap-2"><PixelButton type="button" tone="red" disabled={blocked} onClick={() => void request("remove")}>Confirm definition removal</PixelButton><PixelButton type="button" tone="neutral" disabled={pending} onClick={() => setConfirmRemoval(false)}>Keep integration</PixelButton></div></section> : null}
    <div className="flex flex-wrap gap-2"><PixelButton type="submit" tone="cyan" disabled={blocked || confirmRemoval}>{pending ? "Request in progress…" : instanceId ? "Save desired configuration" : "Create integration"}</PixelButton><PixelButton type="button" tone="neutral" variant="ghost" disabled={pending} onClick={() => void request("reload")}>Reload / review · discard draft</PixelButton><PixelButton type="button" tone="neutral" variant="ghost" onClick={cancel}>Cancel / discard</PixelButton>{instanceId && !confirmRemoval ? <PixelButton type="button" tone="red" variant="ghost" disabled={blocked} onClick={() => { if (!lifetime.current.busy) setConfirmRemoval(true); }}>Remove definition…</PixelButton> : null}</div>
    <p className="integration-muted">Write-only replacements are local to this mounted editor. Keep preserves a credential; only Clear removes it. Leaving this tab discards unsaved replacements. No network probe or service-health claim is made.</p>
  </form>;
}
