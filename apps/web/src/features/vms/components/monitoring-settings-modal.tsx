import { useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { PixelButton, PixelInput, PixelModal } from "@pxlkit/ui-kit";
import { useQueryClient } from "@tanstack/react-query";
import { isApiError } from "../../../lib/api/api-error";
import { queryKeys } from "../../../lib/query/query-keys";
import { getVmMonitoringConfig, saveVmMonitoringConfig } from "../api/monitoring.api";
import { canManageAgent } from "../lib/agent-connect";
import { monitoringFieldId } from "../lib/monitoring-draft";
import type { MonitoringCatalog, MonitoringConfigView, SupportedAgentOs } from "../monitoring.types";

interface Props {
  organizationId: string; vmId: string; role: string | undefined; os: SupportedAgentOs;
  initial: MonitoringConfigView; catalog: MonitoringCatalog; onClose: () => void;
}
// Host interval only. No integration or credential controls live in this dialog.
export function MonitoringSettingsModal({ organizationId, vmId, role, os, initial, catalog, onClose }: Props) {
  const client = useQueryClient();
  const [snapshot, setSnapshot] = useState(() => structuredClone(initial));
  const [interval, setInterval] = useState(initial.definition?.host.intervalSeconds ?? NaN);
  const [pending, setPending] = useState(false); const [conflict, setConflict] = useState(false);
  const [error, setError] = useState(""); const [fieldError, setFieldError] = useState(""); const [notice, setNotice] = useState("");
  const summaryRef = useRef<HTMLDivElement>(null); const closeRef = useRef(onClose);
  useLayoutEffect(() => { closeRef.current = onClose; }, [onClose]);
  const lifetime = useRef({ active: true, busy: false, generation: 0, controller: undefined as AbortController | undefined });
  const allowed = canManageAgent(role);
  const blocked = pending || conflict || !allowed || !snapshot.managed || snapshot.version === null || !snapshot.definition;
  useLayoutEffect(() => {
    const session = lifetime.current; session.active = true;
    return () => { session.active = false; session.generation++; session.controller?.abort(); };
  }, []);
  useLayoutEffect(() => { if (error || fieldError) summaryRef.current?.focus(); }, [error, fieldError]);
  function close() {
    const session = lifetime.current; session.active = false; session.generation++; session.controller?.abort();
    closeRef.current();
  }
  async function request(action: "save" | "reload") {
    const session = lifetime.current;
    if (!session.active || session.busy || !allowed || (action === "save" && blocked)) return;
    if (action === "save" && (!Number.isInteger(interval) || interval < catalog.host.interval.minimum || interval > catalog.host.interval.maximum)) {
      setFieldError(`Gather interval must be a whole number from ${catalog.host.interval.minimum} to ${catalog.host.interval.maximum} seconds.`); return;
    }
    session.busy = true; const generation = ++session.generation;
    const controller = new AbortController(); session.controller = controller;
    setPending(true); setError(""); setFieldError(""); setNotice("");
    try {
      // Clone the entire canonical snapshot; do not call definitionFromDraft,
      // which would rewrite unselected Docker acknowledgement/settings.
      const definition = snapshot.definition ? structuredClone(snapshot.definition) : null;
      if (definition) definition.host = { ...definition.host, intervalSeconds: interval };
      const result = action === "reload" ? await getVmMonitoringConfig(organizationId, vmId, controller.signal)
        : await saveVmMonitoringConfig(organizationId, vmId, { expectedVersion: snapshot.version!, definition: definition!, secrets: {} }, controller.signal);
      if (!session.active || generation !== session.generation) return;
      await client.cancelQueries({ queryKey: queryKeys.vmMonitoringConfig(organizationId, vmId), exact: true });
      if (!session.active || generation !== session.generation) return;
      client.setQueryData(queryKeys.vmMonitoringConfig(organizationId, vmId), result);
      setSnapshot(structuredClone(result)); setInterval(result.definition?.host.intervalSeconds ?? NaN); setConflict(false);
      setNotice(action === "reload" ? "Latest host definition loaded. Unsaved changes were discarded; review before saving." : `Desired version ${result.version ?? "unknown"} saved. Application awaits agent confirmation, not proof of plugin or service health.`);
      if (action === "save") {
        void client.invalidateQueries({ queryKey: queryKeys.vmMonitoringConfig(organizationId, vmId), exact: true });
        void client.invalidateQueries({ queryKey: queryKeys.agentStatus(organizationId, vmId), exact: true });
      }
    } catch (failure) {
      if (!session.active || generation !== session.generation) return;
      const status = isApiError(failure) ? failure.statusCode : 0;
      if (status === 409) { setConflict(true); setError("The server definition changed. Reload and review explicitly before editing again; no automatic merge or retry occurs."); }
      else setError(status === 403 ? "Access denied. Admin or Operator permission is required; the server is authoritative." : status === 404 ? "The VM or native definition is no longer available." : status === 400 || status === 422 ? "The server rejected these settings. Reload and review the canonical definition; raw diagnostics are hidden." : "The request could not be completed. Your interval draft is retained. Reload to review the server version before retrying; a save may already have completed.");
    } finally { if (session.active && generation === session.generation) { session.busy = false; session.controller = undefined; setPending(false); } }
  }
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); void request("save"); }
  return <PixelModal open title="Host gather interval" description={`VM ${vmId} · ${os} · captured desired version ${snapshot.version ?? "unavailable"}`} size="md" onClose={close}>
    <form noValidate onSubmit={submit} className="min-w-0 space-y-4" aria-busy={pending}>
      <p className="text-sm text-retro-muted">Host telemetry only · {catalog.host.profileKey}. Every integration and its credentials are preserved unchanged. Internal agent telemetry remains at 60 seconds.</p>
      {error || fieldError ? <div ref={summaryRef} tabIndex={-1} role="alert" className="border-2 border-retro-red p-3 text-sm text-retro-text"><p>{error || "Review the gather interval:"}</p>{fieldError ? <button type="button" className="underline focus-visible:outline-2 focus-visible:outline-retro-cyan" onClick={() => document.getElementById(monitoringFieldId("host", "interval"))?.focus()}>{fieldError}</button> : null}</div> : null}
      {notice ? <p role="status" aria-live="polite" className="border border-retro-cyan p-3 text-sm text-retro-text">{notice}</p> : null}
      {snapshot.definition ? <div className="min-w-0"><PixelInput aria-invalid={Boolean(fieldError)} aria-describedby={`${monitoringFieldId("host", "interval")}-${fieldError ? "error" : "help"}`} id={monitoringFieldId("host", "interval")} label="Host gather interval (seconds)" type="number" min={catalog.host.interval.minimum} max={catalog.host.interval.maximum} step={1} value={Number.isFinite(interval) ? interval : ""} disabled={blocked} error={fieldError} hint={`Default ${catalog.host.interval.default}s; ${catalog.host.interval.minimum}–${catalog.host.interval.maximum}s. CPU, memory, disk, network and ${os === "windows" ? "uptime; Windows load unsupported" : "load/uptime"}.`} onChange={(event) => { if (blocked || lifetime.current.busy) return; setInterval(event.target.valueAsNumber); setError(""); setFieldError(""); setNotice(""); }} /><span id={`${monitoringFieldId("host", "interval")}-${fieldError ? "error" : "help"}`} className="sr-only">{fieldError || `Default ${catalog.host.interval.default}s; ${catalog.host.interval.minimum}–${catalog.host.interval.maximum}s. CPU, memory, disk, network and ${os === "windows" ? "uptime; Windows load unsupported" : "load/uptime"}.`}</span></div> : <p>No managed native definition is available. No empty defaults will be saved.</p>}
      {interval > 300 ? <p className="text-sm text-retro-gold">Above the five-minute freshness window, host values and network rates may be unavailable between samples; alerts are delayed.</p> : null}
      <div className="flex flex-wrap gap-2"><PixelButton type="submit" tone="cyan" disabled={blocked}>{pending ? "Request in progress…" : "Save host interval"}</PixelButton><PixelButton type="button" tone="neutral" variant="ghost" disabled={pending || !allowed} onClick={() => void request("reload")}>Reload / discard draft</PixelButton><PixelButton type="button" tone="neutral" variant="ghost" onClick={close}>Close / discard</PixelButton></div>
    </form>
  </PixelModal>;
}
