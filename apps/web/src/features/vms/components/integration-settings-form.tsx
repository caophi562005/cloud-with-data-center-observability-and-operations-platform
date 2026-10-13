import { PixelButton, PixelInput, PixelSelect } from "@pxlkit/ui-kit";
import type { IntegrationCatalogEntry, IntegrationDraft, MonitoringFieldError, MonitoringSecretField, SecretPatch, SupportedAgentOs } from "../monitoring.types";
import { monitoringFieldId } from "../lib/monitoring-draft";

const secretLabels: Record<MonitoringSecretField, string> = {
  username: "Username", password: "Password", tlsKeyPassword: "TLS key password",
  oauthClientId: "OAuth client ID", oauthClientSecret: "OAuth client secret",
};
interface Props {
  instance: IntegrationDraft;
  entry: IntegrationCatalogEntry;
  os: SupportedAgentOs;
  disabled: boolean;
  configured: Partial<Record<MonitoringSecretField, boolean>>;
  secrets: Partial<Record<MonitoringSecretField, SecretPatch>>;
  errors: MonitoringFieldError[];
  onChange: (instance: IntegrationDraft) => void;
  onSecretChange: (field: MonitoringSecretField, patch: SecretPatch) => void;
  onRemove: () => void;
}

export function IntegrationSettingsForm({ instance, entry, os, disabled, configured, secrets, errors, onChange, onSecretChange, onRemove }: Props) {
  const id = (field: string) => monitoringFieldId(instance.id, field);
  const error = (field: string) => errors.find((issue) => issue.fieldId === id(field))?.message;
  function changeTarget(patch: Partial<{ host: string; port: number }>) {
    switch (instance.kind) {
      case "redis": onChange({ ...instance, settings: { ...instance.settings, ...patch } }); break;
      case "postgresql": onChange({ ...instance, settings: { ...instance.settings, ...patch } }); break;
      case "mysql": onChange({ ...instance, settings: { ...instance.settings, ...patch } }); break;
    }
  }
  function changePath(patch: Partial<{ tlsCaPath: string | undefined; tlsCertPath: string | undefined; tlsKeyPath: string | undefined }>) {
    switch (instance.kind) {
      case "redis": onChange({ ...instance, settings: { ...instance.settings, ...patch } }); break;
      case "postgresql": onChange({ ...instance, settings: { ...instance.settings, ...patch } }); break;
      case "mysql": onChange({ ...instance, settings: { ...instance.settings, ...patch } }); break;
      case "nginx": onChange({ ...instance, settings: { ...instance.settings, ...patch } }); break;
    }
  }
  function changeTls(tls: boolean) {
    switch (instance.kind) {
      case "redis": onChange({ ...instance, settings: { ...instance.settings, tls } }); break;
      case "mysql": onChange({ ...instance, settings: { ...instance.settings, tls } }); break;
      case "nginx": onChange({ ...instance, settings: { ...instance.settings, tls } }); break;
    }
  }
  // Small, explicit settings branches preserve the discriminated API schema;
  // catalog strings never become arbitrary JSON/DSN/destination editors.
  const tlsPaths = instance.kind === "docker" ? null : <>
    <p className="text-xs text-retro-muted sm:col-span-2">TLS files are absolute paths on the monitored {os} machine, not uploads from this browser. Supply a client certificate and key together.</p>
    <PixelInput id={id("tlsCaPath")} label="TLS CA path (optional)" value={instance.settings.tlsCaPath ?? ""} disabled={disabled} error={error("tlsCaPath")} onChange={(event) => changePath({ tlsCaPath: event.target.value || undefined })} />
    <PixelInput id={id("tlsCertPath")} label="TLS client certificate path (optional)" value={instance.settings.tlsCertPath ?? ""} disabled={disabled} error={error("tlsCertPath")} onChange={(event) => changePath({ tlsCertPath: event.target.value || undefined })} />
    <PixelInput id={id("tlsKeyPath")} label="TLS client key path (optional)" value={instance.settings.tlsKeyPath ?? ""} disabled={disabled} error={error("tlsKeyPath")} onChange={(event) => changePath({ tlsKeyPath: event.target.value || undefined })} />
  </>;

  return <fieldset className="min-w-0 space-y-4 border-2 border-retro-border bg-retro-canvas/30 p-4">
    <legend className="px-2 text-base font-semibold text-retro-text">{entry.title}</legend>
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0 text-xs text-retro-muted"><p className="break-all font-mono">Instance {instance.id}</p><p>Native inputs.{entry.plugin} · Telegraf {entry.compatibility} · {entry.supportedOs.join(" / ")}</p></div>
      <PixelButton type="button" tone="red" variant="ghost" size="sm" disabled={disabled} onClick={onRemove} aria-label={`Remove ${entry.title} instance ${instance.id}`}>Remove instance</PixelButton>
    </div>
    {entry.warning ? <p className="border border-retro-gold bg-retro-gold/10 p-3 text-sm text-retro-text">{entry.warning}</p> : null}
    <div className="grid min-w-0 gap-4 sm:grid-cols-2">
      <label className="flex items-center gap-2 text-sm text-retro-text"><input type="checkbox" checked={instance.enabled} disabled={disabled} onChange={(event) => onChange({ ...instance, enabled: event.target.checked })} className="focus-visible:outline-2 focus-visible:outline-retro-cyan" />Enabled (disabling preserves settings and credentials)</label>
      <PixelInput id={id("interval")} label="Gather interval (seconds)" type="number" min={15} max={3600} step={1} value={Number.isFinite(instance.intervalSeconds) ? instance.intervalSeconds : ""} disabled={disabled} error={error("interval")} onChange={(event) => onChange({ ...instance, intervalSeconds: event.target.valueAsNumber })} />
      {instance.kind === "redis" || instance.kind === "postgresql" || instance.kind === "mysql" ? <>
        <PixelInput id={id("host")} label="Service hostname or IP" value={instance.settings.host} maxLength={253} disabled={disabled} error={error("host")} onChange={(event) => changeTarget({ host: event.target.value })} />
        <PixelInput id={id("port")} label="Service port" type="number" min={1} max={65535} step={1} value={Number.isFinite(instance.settings.port) ? instance.settings.port : ""} disabled={disabled} error={error("port")} onChange={(event) => changeTarget({ port: event.target.valueAsNumber })} />
      </> : null}
      {instance.kind === "postgresql" ? <>
        <PixelInput id={id("database")} label="Database name" value={instance.settings.database} maxLength={128} disabled={disabled} error={error("database")} onChange={(event) => onChange({ ...instance, settings: { ...instance.settings, database: event.target.value } })} />
        <PixelSelect id={id("sslMode")} label="PostgreSQL SSL mode" value={instance.settings.sslMode} options={[{ value: "verify-full", label: "verify-full" }, { value: "disable", label: "disable" }]} disabled={disabled} onChange={(value) => onChange({ ...instance, settings: { ...instance.settings, sslMode: value === "disable" ? "disable" : "verify-full" } })} />
      </> : null}
      {instance.kind === "nginx" ? <>
        <PixelInput id={id("statusUrl")} label="Nginx stub-status URL" type="url" value={instance.settings.statusUrl} maxLength={2048} disabled={disabled} error={error("statusUrl")} onChange={(event) => onChange({ ...instance, settings: { ...instance.settings, statusUrl: event.target.value } })} />
        <PixelInput id={id("oauthTokenUrl")} label="OAuth token URL (optional, HTTPS)" type="url" value={instance.settings.oauthTokenUrl ?? ""} maxLength={2048} disabled={disabled} error={error("oauthTokenUrl")} onChange={(event) => onChange({ ...instance, settings: { ...instance.settings, oauthTokenUrl: event.target.value || undefined } })} />
        <p className="text-xs text-retro-muted sm:col-span-2">These are service targets on the monitored machine's network, not metrics/control destinations. No URL userinfo, query or fragment. OAuth requires paired client ID and secret; Basic Auth is not supported.</p>
      </> : null}
      {instance.kind === "redis" || instance.kind === "mysql" || instance.kind === "nginx" ? <div>
        <label className="flex items-center gap-2 text-sm text-retro-text"><input id={id("tls")} type="checkbox" checked={instance.settings.tls} disabled={disabled} aria-invalid={Boolean(error("tls"))} aria-describedby={error("tls") ? `${id("tls")}-error` : undefined} onChange={(event) => changeTls(event.target.checked)} className="focus-visible:outline-2 focus-visible:outline-retro-cyan" />Enable TLS{instance.kind === "nginx" ? " (required for HTTPS)" : ""}</label>
        {error("tls") ? <p id={`${id("tls")}-error`} className="mt-1 text-xs text-retro-red">{error("tls")}</p> : null}
      </div> : null}
      {tlsPaths}
      {instance.kind === "docker" ? <>
        <PixelInput id={id("endpoint")} label={`Protected local Docker endpoint (${os})`} value={instance.settings.endpoint} readOnly hint="Fixed by the agent OS; no remote URL editing." />
        <div><label className="flex items-start gap-2 text-sm text-retro-text"><input id={id("acknowledge")} type="checkbox" checked={instance.settings.acknowledgePrivilegedAccess} disabled={disabled} aria-invalid={Boolean(error("acknowledge"))} aria-describedby={error("acknowledge") ? `${id("acknowledge")}-error` : undefined} onChange={(event) => onChange({ ...instance, settings: { ...instance.settings, acknowledgePrivilegedAccess: event.target.checked } })} className="mt-1 focus-visible:outline-2 focus-visible:outline-retro-cyan" />I explicitly acknowledge that local Docker access grants administrative container and host privileges.</label>
          {error("acknowledge") ? <p id={`${id("acknowledge")}-error`} className="mt-1 text-xs text-retro-red">{error("acknowledge")}</p> : null}</div>
      </> : null}
    </div>
    {entry.secretFields.length ? <div className="space-y-3 border-t border-retro-border pt-4">
      <p className="text-xs text-retro-muted">Write-only credentials. Keep preserves the stored value; Replace requires a nonblank value; only Clear removes it. Closing discards unsaved replacements.</p>
      {entry.secretFields.map((field) => {
        const patch = secrets[field] ?? { action: "keep" };
        return <div key={field} className="grid min-w-0 gap-3 sm:grid-cols-2">
          <PixelSelect id={patch.action === "set" ? `${id(field)}-action` : id(field)} label={`${secretLabels[field]} · ${configured[field] ? "configured" : "not configured"}`} value={patch.action} disabled={disabled} error={patch.action === "set" ? undefined : error(field)} options={[{ value: "keep", label: "Keep stored value" }, { value: "set", label: "Replace value" }, { value: "clear", label: "Clear stored value" }]} onChange={(action) => onSecretChange(field, action === "set" ? { action: "set", value: "" } : action === "clear" ? { action: "clear" } : { action: "keep" })} />
          {patch.action === "set" ? <PixelInput id={id(field)} label={`New ${secretLabels[field].toLowerCase()}`} type="password" autoComplete="new-password" spellCheck={false} value={patch.value} disabled={disabled} error={error(field)} onChange={(event) => onSecretChange(field, { action: "set", value: event.target.value })} /> : <p className="self-center text-xs text-retro-muted">{patch.action === "clear" ? "Will remove this credential on save." : "No value is fetched or prefilled."}</p>}
        </div>;
      })}
    </div> : null}
  </fieldset>;
}
